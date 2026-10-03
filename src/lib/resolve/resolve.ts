import { TIER_ORDER, type Platform, type ResolveTier } from '@/lib/domain'

import { createFirecrawlExtractor, createJinaExtractor } from './extractors/reader'
import { createOneboundExtractor } from './extractors/onebound'
import { createStructuredExtractor } from './extractors/structured'
import { hostnameOf, matchPlatform } from './platforms'
import { expandShortLink, extractUrlFromText } from './shortlink'
import { createVlmFallbackExtractor } from './vlm-fallback'
import type { ExtractContext, ExtractResult, Extractor, ResolveAttempt, ResolveOutcome } from './types'

/**
 * 默认的提取器集合。
 *
 * 按 TIER_ORDER 排序 —— 次序是产品决策（先免费精准、后昂贵模糊），
 * 写死在 domain 里而不是散落在各文件，改一处即可。
 */
export function defaultExtractors(): Extractor[] {
  const byTier = new Map<ResolveTier, Extractor>([
    ['onebound', createOneboundExtractor()],
    ['structured', createStructuredExtractor()],
    ['jina', createJinaExtractor()],
    ['firecrawl', createFirecrawlExtractor()],
    ['vlm', createVlmFallbackExtractor()],
  ])

  return TIER_ORDER.filter((tier) => byTier.has(tier)).map((tier) => byTier.get(tier)!)
}

/**
 * 整条解析链的时间预算。
 *
 * 必须有：Jina/Firecrawl 这类渲染代理单次就可能耗掉 40 秒，
 * 若不加约束，一个解析不了的链接会让用户对着"正在解析…"干等一两分钟，
 * 才终于被告知"请发截图"。而在对话式交互里，**及时请用户发截图**
 * 远比多等 30 秒去赌一次自动解析更有价值 —— 用户发一张截图只要 3 秒。
 *
 * 20 秒是个取舍：足够 `structured`（12 秒超时）跑完并给 Jina 一点机会，
 * 又不至于让人怀疑卡死。
 */
const DEFAULT_DEADLINE_MS = 20_000

export interface ResolveOptions {
  /** 测试注入用：覆盖各档位的提取器 */
  extractors?: Extractor[]
  /** 测试注入用：短链展开所用的 fetch（各提取器自带自己的注入点） */
  fetchImpl?: typeof fetch
  /** 整条链的时间预算，默认 20 秒 */
  deadlineMs?: number
  signal?: AbortSignal
}

function manualFailure(
  reason: string,
  finalUrl: string | null,
  platform: Platform,
  attempts: ResolveAttempt[],
): ResolveOutcome {
  return { ok: false, tier: 'manual', reason, finalUrl, platform, attempts }
}

/**
 * 把用户给的链接或分享文案解析成一组候选商品图。
 *
 * **本函数承诺不抛异常。** 这不是防御性编程的洁癖，而是产品要求：
 * 三种失败（链接坏了 / 平台反爬 / 没配置 Key）对用户的价值完全相同 ——
 * 都应该是"请发一张商品截图"，而不是一个 500 或一句看不懂的内部错误。
 * 因此所有失败路径都收敛到 `tier: 'manual'` 的返回，只在日志里区分原因。
 *
 * `attempts` 全程记录，既用于诊断，也用于在对话里如实告诉用户卡在哪一步
 * （"淘宝链接需要平台 API，当前未配置" 比 "解析失败" 有用得多）。
 */
export async function resolveProductLink(
  input: string,
  options: ResolveOptions = {},
): Promise<ResolveOutcome> {
  const attempts: ResolveAttempt[] = []
  const extractors = options.extractors ?? defaultExtractors()

  // 整条链共享一个截止时间。既用于"不再开始新档位"的判据，
  // 也作为 AbortSignal 传给正在跑的档位，让它们能被打断。
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS
  const deadlineAt = Date.now() + deadlineMs
  const budgetAbort = AbortSignal.timeout(deadlineMs)
  const budgetSignal = options.signal
    ? AbortSignal.any([options.signal, budgetAbort])
    : budgetAbort

  // ── 1. 从输入里抽链接 ────────────────────────────────────────
  const { url, hasShareCode } = extractUrlFromText(input)

  if (!url) {
    return manualFailure(
      hasShareCode
        ? '这看起来是淘口令一类的分享码，需要打开 App 才能看到商品。请直接发一张商品截图，我来识别。'
        : '没有从输入里找到链接。可以直接粘贴商品地址，或发一张商品截图。',
      null,
      'other',
      attempts,
    )
  }

  let finalUrl = url
  const host = hostnameOf(finalUrl)

  if (!host) {
    return manualFailure(`链接格式不正确：${url}`, url, 'other', attempts)
  }

  // platform 会在短链展开后重新识别，所以是 let；isShortLink 不需要变
  const initialMatch = matchPlatform(host)
  let platform = initialMatch.platform
  const isShortLink = initialMatch.isShortLink

  /**
   * 短链展开的情况。
   *
   * 刻意**不**塞进 attempts：attempts 记的是"各解析档位的战绩"，
   * 把展开失败伪装成某个档位的失败会污染"试了几种方式"的计数，
   * 也会让对话里的解释变得莫名其妙。它作为一句独立备注带到最终说明里。
   */
  let expansionNote: string | null = null

  // ── 2. 展开短链 ─────────────────────────────────────────────
  // 国内电商分享几乎都走短链，不展开就识别不出真实平台。
  // 展开失败也**继续走**：有些短链本身就是可读页面，
  // 提前放弃会白白丢掉一次成功机会。
  if (isShortLink) {
    const expanded = await expandShortLink(finalUrl, {
      fetchImpl: options.fetchImpl,
      signal: budgetSignal,
    })

    if (expanded.finalUrl !== finalUrl) {
      finalUrl = expanded.finalUrl

      const expandedHost = hostnameOf(finalUrl)
      if (expandedHost) {
        platform = matchPlatform(expandedHost).platform
      }
    }

    if (!expanded.complete) {
      expansionNote = `短链展开未走完（${expanded.detail}）`
    }
  }

  // ── 3. 按次序尝试各档位 ──────────────────────────────────────
  // 显式计数而不是事后从 attempts 里数：跳过与真跑过是两种不同的经历，
  // 用字符串前缀去区分它们是在给自己埋雷。
  let triedCount = 0

  for (const extractor of extractors) {
    const availability = extractor.availability()

    if (!availability.available) {
      attempts.push({
        tier: extractor.tier,
        ok: false,
        detail: `跳过：${availability.reason}`,
        elapsedMs: 0,
      })
      continue
    }

    // 预算用尽就停在这里，不再开新档位。剩下的档位如实记为"未尝试"，
    // 而不是伪装成失败 —— 用户看到的解释应当是"时间不够"，不是"这种方式不行"。
    if (Date.now() >= deadlineAt) {
      attempts.push({
        tier: extractor.tier,
        ok: false,
        detail: `跳过：已用尽 ${Math.round(deadlineMs / 1000)} 秒解析预算`,
        elapsedMs: 0,
      })
      continue
    }

    triedCount += 1

    const startedAt = Date.now()
    const ctx: ExtractContext = { finalUrl, platform, signal: budgetSignal }

    let result: ExtractResult
    try {
      result = await extractor.extract(ctx)
    } catch (error) {
      // 各 extractor 都承诺不抛，但编排层再兜一次：一个档位的 bug
      // 不应该让整条链路失败。这是"不抛异常"承诺的最后一道保险。
      result = {
        ok: false,
        reason: `档位内部异常：${error instanceof Error ? error.message : String(error)}`,
      }
    }

    const elapsedMs = Date.now() - startedAt

    if (result.ok) {
      attempts.push({
        tier: extractor.tier,
        ok: true,
        detail: `找到 ${result.candidates.length} 张候选图`,
        elapsedMs,
      })

      return {
        ok: true,
        tier: extractor.tier,
        finalUrl: result.finalUrl ?? finalUrl,
        platform,
        title: result.title ?? null,
        candidates: result.candidates,
        attempts,
      }
    }

    attempts.push({ tier: extractor.tier, ok: false, detail: result.reason, elapsedMs })
  }

  // ── 4. 全部失败 → 引导用户发截图 ─────────────────────────────
  const summary =
    triedCount === 0
      ? '这条链接暂时没有可用的自动解析方式，请直接发一张商品截图。'
      : `${triedCount} 种自动解析方式都没能取到商品图，请直接发一张商品截图，我来识别。`

  return manualFailure(
    expansionNote ? `${summary}（另：${expansionNote}）` : summary,
    finalUrl,
    platform,
    attempts,
  )
}
