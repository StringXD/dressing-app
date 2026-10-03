import { describe, expect, it } from 'vitest'

import { TASK_KINDS, type TaskKind } from '@/lib/domain'

import { getModelById, MODELS } from './models.config'
import {
  NoModelAvailableError,
  listModels,
  resolveCheaperFallback,
  resolveModel,
} from './registry'

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

  it('选出的模型永远是可商用的', () => {
    for (const kind of ['tryon', 'hair'] as const) {
      expect(resolveModel(kind).license).toBe('commercial')
    }
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
  it('每个条目都是可商用的', () => {
    // 调研已确认主流开源换装方案（OOTDiffusion/CatVTON 等）为 CC BY-NC-SA 4.0，
    // 禁商用。这条断言是防止有人后续"图省事"补一个 research 条目进来。
    for (const model of MODELS) {
      expect(model.license, `${model.id} 不可商用`).toBe('commercial')
    }
  })

  it('id 唯一', () => {
    const ids = MODELS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('没有收录已知的非商用端点', () => {
    // fal-ai/cat-vton 的 licenseType 是 research，产品化即法律风险
    expect(MODELS.some((m) => m.endpoint.includes('cat-vton'))).toBe(false)
  })

  it('每个条目的 id 都能按 id 查回来', () => {
    for (const model of MODELS) {
      expect(getModelById(model.id)?.endpoint).toBe(model.endpoint)
    }
  })
})
