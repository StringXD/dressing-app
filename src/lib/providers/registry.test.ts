import { describe, expect, it } from 'vitest'

import { TASK_KINDS, type TaskKind } from '@/lib/domain'

import { getModelById, MODELS } from './models.config'
import {
  NoModelAvailableError,
  licenseWarningText,
  listModels,
  pickCheaperFallback,
  pickModel,
  researchModels,
  resolveCheaperFallback,
  resolveModel,
} from './registry'
import type { ModelSpec } from './types'

const FASHN = 'fal/fashn-tryon-1.6'
const APP_TRYON = 'fal/apps-v2-tryon'
const HAIR = 'fal/hair-change'

describe('resolveModel', () => {
  it('不指定档位时选质量最高的（当前产品取向：先要效果）', () => {
    expect(resolveModel('tryon').id).toBe(FASHN)
  })

  it('指定 budget 时选中经济档', () => {
    expect(resolveModel('tryon', { tier: 'budget' }).id).toBe(APP_TRYON)
  })

  it('指定 premium 时选中旗舰档', () => {
    expect(resolveModel('tryon', { tier: 'premium' }).id).toBe(FASHN)
  })

  it('档位没有精确匹配时向下降级，绝不向上超预算', () => {
    // tryon 只有 premium 与 budget，没有 standard。
    // 用户要 standard 应当拿到 budget（便宜），而不是被悄悄升级到 premium。
    const picked = resolveModel('tryon', { tier: 'standard' })

    expect(picked.id).toBe(APP_TRYON)
    expect(picked.tier).toBe('budget')
  })

  it('换发型任务路由到换发型模型，不会拿到试穿模型', () => {
    const picked = resolveModel('hair')

    expect(picked.id).toBe(HAIR)
    expect(picked.kind).toBe('hair')
  })

  it('每个 TaskKind 都至少有一个可用模型', () => {
    // 这才是真正要守的不变量：往 TASK_KINDS 里加了一种任务却忘了配模型，
    // 要到运行时才炸。这条断言让它在 CI 阶段就暴露。
    for (const kind of TASK_KINDS) {
      expect(resolveModel(kind), `${kind} 没有可用模型`).toBeDefined()
    }
  })

  it('没有任何模型可用的任务类型抛出可读错误', () => {
    // 今天 TASK_KINDS 的每个取值都配了模型，所以这条分支走不到。
    // 仍然断言它，是为了将来有人加了新任务类型却没配模型时，
    // 拿到的是可读错误而不是 undefined 引发的崩溃。
    expect(() => resolveModel('unknown-kind' as TaskKind)).toThrow(NoModelAvailableError)
  })
})

describe('resolveCheaperFallback', () => {
  it('为旗舰试穿模型找到更便宜的降级目标', () => {
    const premium = getModelById(FASHN)
    expect(premium).toBeDefined()

    const fallback = resolveCheaperFallback(premium!)

    expect(fallback?.id).toBe(APP_TRYON)
    expect(fallback!.costUsdPerRun).toBeLessThan(premium!.costUsdPerRun)
  })

  it('已经是最便宜的模型时返回 null，而不是原样返回自己', () => {
    // 返回自己会导致"降级重试"其实是在原地重试同一个模型，白白多烧一次钱
    const cheapest = getModelById(APP_TRYON)
    expect(resolveCheaperFallback(cheapest!)).toBeNull()
  })

  it('换发型模型没有更便宜的同类可选', () => {
    expect(resolveCheaperFallback(getModelById(HAIR)!)).toBeNull()
  })

  it('降级目标永远与原模型同类型', () => {
    const fallback = resolveCheaperFallback(getModelById(FASHN)!)

    expect(fallback?.kind).toBe('tryon')
  })
})

describe('listModels', () => {
  it('按价格升序排列', () => {
    const costs = listModels('tryon').map((m) => m.costUsdPerRun)

    expect(costs).toEqual([...costs].sort((a, b) => a - b))
  })

  it('只返回指定类型', () => {
    expect(listModels('hair').every((m) => m.kind === 'hair')).toBe(true)
  })
})

describe('注册表自检', () => {
  it('license 字段必须存在且取值合法', () => {
    // **刻意不断言"必须可商用"** —— 政策允许收录 research 条目（效果优先）。
    // 要守的是"如实标注"：整条政策建立在"license 是给使用者的警示"之上，
    // 所以警示本身必须准确，既不能漏写也不能写错。
    for (const model of MODELS) {
      expect(['commercial', 'research'], `${model.id} 的 license 非法`).toContain(model.license)
    }
  })

  it('id 唯一', () => {
    const ids = MODELS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每个条目的 id 都能按 id 查回来', () => {
    for (const model of MODELS) {
      expect(getModelById(model.id)?.endpoint).toBe(model.endpoint)
    }
  })
})

/**
 * 这一组是"允许收录 research 条目"这条政策的**唯一守护**。
 *
 * 背景：旧代码里 `candidatesFor` 硬过滤 `license === 'commercial'`，于是任何 research
 * 条目都永远选不中；而当时的测试断言的是"注册表里没有 research 条目"，所以全绿。
 * 政策允许的能力被代码静默取消，测试却看不见。
 *
 * 正因为如此，下面用**合成注册表**而不是真实的 MODELS —— 真实注册表今天一个
 * research 条目都没有，拿它来测等于什么都没测。
 */
describe('含 research 条目的注册表', () => {
  const commercial: ModelSpec = {
    id: 'x/budget',
    providerId: 'x',
    endpoint: 'x/tryon-budget',
    kind: 'tryon',
    label: '便宜的可商用档',
    costUsdPerRun: 0.01,
    license: 'commercial',
    tier: 'budget',
  }

  const research: ModelSpec = {
    id: 'y/premium-research',
    providerId: 'y',
    endpoint: 'y/tryon-premium',
    kind: 'tryon',
    label: '效果最好但禁商用',
    costUsdPerRun: 0.06,
    license: 'research',
    tier: 'premium',
  }

  const synthetic = [commercial, research]

  it('research 条目确实能被选中 —— 否则"允许收录"只是一句空话', () => {
    expect(pickModel(synthetic, 'tryon', { tier: 'premium' })?.id).toBe(research.id)
  })

  it('不指定档位时按"效果优先"选，research 条目可以成为默认', () => {
    // 这条最能体现政策：默认挑质量最高的，不因为它禁商用就绕开
    expect(pickModel(synthetic, 'tryon')?.id).toBe(research.id)
  })

  it('降级重试也能落到 research 条目上，不被悄悄排除', () => {
    const cheaperResearch: ModelSpec = {
      ...research,
      id: 'y/cheap-research',
      costUsdPerRun: 0.005,
    }

    // 唯一比它便宜的是另一个 research 条目 —— 旧过滤若还在，这里会拿到 null
    const fallback = pickCheaperFallback([research, cheaperResearch], research)

    expect(fallback?.id).toBe('y/cheap-research')
  })

  it('启动告警点名每个非商用条目，但不误伤可商用的那些', () => {
    const text = licenseWarningText(synthetic)

    expect(text).not.toBeNull()
    expect(text).toContain(research.endpoint)
    // 把可商用的一起点名会让告警失去区分度，等于没说
    expect(text).not.toContain(commercial.endpoint)
  })

  it('全是可商用条目时不产生告警', () => {
    expect(licenseWarningText([commercial])).toBeNull()
    expect(researchModels([commercial])).toEqual([])
  })
})
