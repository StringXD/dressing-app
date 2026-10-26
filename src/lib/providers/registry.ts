import type { TaskKind } from '@/lib/domain'

import { MODELS } from './models.config'
import type { ModelSpec, ModelTier } from './types'

/** 档位排序：数字越大越"重"（越贵、质量越高） */
const TIER_RANK: Record<ModelTier, number> = {
  budget: 1,
  standard: 2,
  premium: 3,
}

export class NoModelAvailableError extends Error {
  constructor(kind: TaskKind, detail: string) {
    super(`没有可用于 ${kind} 的模型：${detail}`)
    this.name = 'NoModelAvailableError'
  }
}

/**
 * 从给定清单里挑出某任务类型的候选。
 *
 * **刻意不按 license 过滤。** v2 曾在这里硬过滤 `license === 'commercial'`，
 * 结果是：照政策加进来的 `research` 条目会**静默地永远选不中**，而测试还是绿的
 * （测试断言的是"注册表里没有 research 条目"）。政策允许收录、代码却让它失效，
 * 是比禁止更糟的状态。
 *
 * 现在由使用者按自己的用途取舍，`license` 只作为警示如实标注 ——
 * 且启动时会主动把非商用条目打出来，见下面的 `licenseWarningText()`。
 */
function candidatesFor(kind: TaskKind, models: readonly ModelSpec[]): ModelSpec[] {
  return models.filter((m) => m.kind === kind)
}

/**
 * 从给定清单里选模型。**纯函数**，接收 models 而不是直接读模块级 MODELS。
 *
 * 抽出来是为了让单测能喂一份**含 `research` 条目**的清单 —— 否则
 * "允许收录 research"这条政策就没有任何断言守着，又会退回静默失效。
 * 返回 null 表示该类型无可用模型，由调用方决定是抛错还是别的处理。
 */
export function pickModel(
  models: readonly ModelSpec[],
  kind: TaskKind,
  options: { tier?: ModelTier } = {},
): ModelSpec | null {
  const candidates = candidatesFor(kind, models)

  if (candidates.length === 0) return null

  const byRankDesc = [...candidates].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])

  if (!options.tier) {
    // 不指定档位时选**质量最高**的那档 —— 当前产品取向：先把效果做出来
    return byRankDesc[0]
  }

  const exact = candidates.find((m) => m.tier === options.tier)
  if (exact) return exact

  // 没有精确匹配时，退到**不高于**目标档位里最好的那个：
  // 用户要 budget 却拿到 premium 会超预算，反过来只是效果差一点。
  const targetRank = TIER_RANK[options.tier]
  const atOrBelow = byRankDesc.find((m) => TIER_RANK[m.tier] <= targetRank)

  return atOrBelow ?? byRankDesc[byRankDesc.length - 1]
}

/** 从给定清单里找一个更便宜的同类型模型。没有更便宜的时返回 null。 */
export function pickCheaperFallback(
  models: readonly ModelSpec[],
  model: ModelSpec,
): ModelSpec | null {
  const cheaper = candidatesFor(model.kind, models)
    .filter((m) => m.costUsdPerRun < model.costUsdPerRun)
    .sort((a, b) => a.costUsdPerRun - b.costUsdPerRun)

  return cheaper[0] ?? null
}

/** 按任务类型与档位从注册表选模型。无可用模型时抛出可读错误。 */
export function resolveModel(kind: TaskKind, options: { tier?: ModelTier } = {}): ModelSpec {
  const picked = pickModel(MODELS, kind, options)

  if (!picked) {
    throw new NoModelAvailableError(kind, '注册表中没有该类型的模型')
  }

  return picked
}

/** 找一个更便宜的同类型模型，用于失败降级重试 */
export function resolveCheaperFallback(model: ModelSpec): ModelSpec | null {
  return pickCheaperFallback(MODELS, model)
}

/** 列出某类型的所有模型，供界面展示"用哪个模型/多少钱" */
export function listModels(kind: TaskKind): ModelSpec[] {
  return candidatesFor(kind, MODELS).sort((a, b) => a.costUsdPerRun - b.costUsdPerRun)
}

/** 注册表里所有**禁商用**的条目 */
export function researchModels(models: readonly ModelSpec[] = MODELS): ModelSpec[] {
  return models.filter((m) => m.license === 'research')
}

/**
 * 启动时要打印的授权告警；没有非商用条目时返回 null。
 *
 * 政策允许收录 `research` 条目（效果优先），代价是使用者可能没注意到自己在用一个
 * 禁商用的模型 —— 所以**主动提醒**是这条政策的一部分，不是可选项。
 * 只靠 README 里的一张表不够：真正会踩坑的是直接 `git clone` 就跑起来的人。
 */
export function licenseWarningText(models: readonly ModelSpec[] = MODELS): string | null {
  const risky = researchModels(models)

  if (risky.length === 0) return null

  const lines = risky.map((m) => `  · ${m.label}（${m.endpoint}）`)

  return [
    `注册表里有 ${risky.length} 个模型是**禁商用**授权，你自己用没问题，拿去赚钱有法律风险：`,
    ...lines,
    '  需要商用请改用 registry 里的 commercial 条目，README 有可商用替代清单。',
  ].join('\n')
}
