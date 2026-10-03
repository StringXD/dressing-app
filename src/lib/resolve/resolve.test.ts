import { describe, expect, it } from 'vitest'

import { TIER_ORDER } from '@/lib/domain'

import { defaultExtractors, resolveProductLink } from './resolve'
import type { Extractor, ResolveCandidate } from './types'

const PRODUCT_URL = 'https://shop.example.com/products/feng-yi'

const CANDIDATE: ResolveCandidate = { imageUrl: 'https://cdn.example.com/a.jpg' }

/** 造一个假档位。默认行为是"可用但找不到图"，测试里按需覆盖。 */
function makeExtractor(overrides: Partial<Extractor> & Pick<Extractor, 'tier'>): Extractor {
  return {
    availability: () => ({ available: true }),
    extract: async () => ({ ok: false, reason: '没找到' }),
    ...overrides,
  }
}

const succeed = (tier: Extractor['tier']): Extractor =>
  makeExtractor({
    tier,
    extract: async () => ({ ok: true, candidates: [CANDIDATE], title: '风衣' }),
  })

const fail = (tier: Extractor['tier'], reason = '没找到'): Extractor =>
  makeExtractor({ tier, extract: async () => ({ ok: false, reason }) })

const unavailable = (tier: Extractor['tier'], reason: string): Extractor =>
  makeExtractor({ tier, availability: () => ({ available: false, reason }) })

const boom = (tier: Extractor['tier']): Extractor =>
  makeExtractor({
    tier,
    extract: async () => {
      throw new Error('档位内部炸了')
    },
  })

describe('成功路径', () => {
  it('第一个可用的档位成功即返回', async () => {
    const result = await resolveProductLink(PRODUCT_URL, {
      extractors: [succeed('structured')],
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.tier).toBe('structured')
    expect(result.ok && result.candidates).toEqual([CANDIDATE])
    expect(result.ok && result.title).toBe('风衣')
  })

  it('前面的档位失败后继续往后试', async () => {
    const result = await resolveProductLink(PRODUCT_URL, {
      extractors: [fail('onebound', '不覆盖该平台'), fail('structured', '没有图'), succeed('jina')],
    })

    expect(result.ok && result.tier).toBe('jina')
    expect(result.ok && result.attempts.map((a) => a.ok)).toEqual([false, false, true])
  })

  it('成功的档位会把最终地址带回', async () => {
    const result = await resolveProductLink(PRODUCT_URL, {
      extractors: [succeed('structured')],
    })

    expect(result.ok && result.finalUrl).toBe(PRODUCT_URL)
  })
})

describe('降级到 Tier D（引导用户发截图）', () => {
  it('全部档位失败时返回 manual 而不是抛错', async () => {
    const result = await resolveProductLink(PRODUCT_URL, {
      extractors: [fail('structured'), fail('jina')],
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.tier).toBe('manual')
    expect(result.ok === false && result.reason).toContain('截图')
  })

  it('一次都没真正跑过时，措辞不说"N 种方式都失败"', async () => {
    // 一个 Key 都没配的情况下，说"3 种方式都失败了"是误导 —— 它们压根没跑
    const result = await resolveProductLink(PRODUCT_URL, {
      extractors: [
        unavailable('onebound', '未配置万邦 Key'),
        unavailable('firecrawl', '未配置 Key'),
        unavailable('vlm', '缺少无头浏览器'),
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('暂时没有可用的自动解析方式')
    expect(result.ok === false && result.reason).not.toContain('3 种')
  })

  it('跑过但都失败时，报出实际尝试的种类数', async () => {
    const result = await resolveProductLink(PRODUCT_URL, {
      extractors: [fail('structured'), fail('jina'), unavailable('firecrawl', '未配置 Key')],
    })

    expect(result.ok === false && result.reason).toContain('2 种')
  })

  it('attempts 如实记录每个档位的结果与跳过原因', async () => {
    const result = await resolveProductLink(PRODUCT_URL, {
      extractors: [fail('structured', '没有图'), unavailable('firecrawl', '未配置 FIRECRAWL_API_KEY')],
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.attempts).toEqual([
      { tier: 'structured', ok: false, detail: '没有图', elapsedMs: expect.any(Number) },
      {
        tier: 'firecrawl',
        ok: false,
        detail: '跳过：未配置 FIRECRAWL_API_KEY',
        elapsedMs: 0,
      },
    ])
  })
})

describe('输入的容错', () => {
  it('淘口令这类分享码给出专门的说明', async () => {
    const result = await resolveProductLink('8￥CZ3457abcdef￥ 复制打开淘宝')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('淘口令')
    expect(result.ok === false && result.finalUrl).toBeNull()
  })

  it('纯文字输入不抛错', async () => {
    const result = await resolveProductLink('帮我换一件风衣')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.tier).toBe('manual')
  })

  it('空字符串不抛错', async () => {
    await expect(resolveProductLink('')).resolves.toMatchObject({ ok: false })
  })

  it('从分享文案里抽出链接后正常解析', async () => {
    const result = await resolveProductLink(
      `【淘宝】${PRODUCT_URL} CZ3457 「风衣」点击链接直接打开`,
      { extractors: [succeed('structured')] },
    )

    expect(result.ok).toBe(true)
    expect(result.ok && result.finalUrl).toBe(PRODUCT_URL)
  })
})

describe('"不抛异常"的保证', () => {
  it('档位内部抛异常时链路继续，不影响后续档位', async () => {
    const result = await resolveProductLink(PRODUCT_URL, {
      extractors: [boom('onebound'), succeed('structured')],
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.tier).toBe('structured')
    expect(result.ok && result.attempts[0].detail).toContain('档位内部异常')
  })

  it('所有档位都抛异常时收敛成 manual', async () => {
    const result = await resolveProductLink(PRODUCT_URL, {
      extractors: [boom('structured'), boom('jina')],
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.tier).toBe('manual')
  })

  it('提取器数组为空时也收敛成 manual', async () => {
    const result = await resolveProductLink(PRODUCT_URL, { extractors: [] })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.tier).toBe('manual')
  })

  it('短链展开所用的 fetch 抛异常时不影响整体', async () => {
    const result = await resolveProductLink('https://m.tb.cn/h.abc', {
      extractors: [fail('structured', '没有图')],
      fetchImpl: (async () => {
        throw new Error('网络炸了')
      }) as typeof fetch,
    })

    expect(result.ok).toBe(false)
    // 展开失败要作为备注出现在说明里，而不是被吞掉
    expect(result.ok === false && result.reason).toContain('短链展开未走完')
  })
})

describe('短链处理', () => {
  it('展开后重新识别平台，并按新平台解析', async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://item.jd.com/100012043978.html' },
      })) as typeof fetch

    let seenPlatform: string | null = null
    const recorder = makeExtractor({
      tier: 'structured',
      extract: async (ctx) => {
        seenPlatform = ctx.platform
        return { ok: true, candidates: [CANDIDATE] }
      },
    })

    const result = await resolveProductLink('https://m.tb.cn/h.abc', {
      extractors: [recorder],
      fetchImpl,
    })

    expect(result.ok).toBe(true)
    // 短链域名 m.tb.cn 属于淘宝，展开后应变成京东
    expect(seenPlatform).toBe('jd')
    expect(result.ok && result.finalUrl).toBe('https://item.jd.com/100012043978.html')
  })

  it('展开失败仍继续尝试（有些短链本身就是可读页面）', async () => {
    const fetchImpl = (async () => {
      throw new Error('超时')
    }) as typeof fetch

    const result = await resolveProductLink('https://m.tb.cn/h.abc', {
      extractors: [succeed('structured')],
      fetchImpl,
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.finalUrl).toBe('https://m.tb.cn/h.abc')
  })

  it('非短链不做展开请求', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      throw new Error('不该被调用')
    }) as typeof fetch

    await resolveProductLink(PRODUCT_URL, { extractors: [succeed('structured')], fetchImpl })

    expect(called).toBe(false)
  })
})

describe('默认档位集合', () => {
  it('顺序与 TIER_ORDER 一致', () => {
    const tiers = defaultExtractors().map((e) => e.tier)
    const expected = TIER_ORDER.filter((t) => t !== 'manual')

    expect(tiers).toEqual([...expected])
  })

  it('不包含 manual（它是终态，不是提取器）', () => {
    expect(defaultExtractors().some((e) => e.tier === 'manual')).toBe(false)
  })

  it('在没有配置任何 Key 时也能构造出来', () => {
    // 缺 Key 不能阻止链路装配 —— 那样用户连"请发截图"都看不到
    expect(() => defaultExtractors()).not.toThrow()
  })
})
