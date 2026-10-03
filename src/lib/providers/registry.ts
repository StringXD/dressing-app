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
 * 所有可选模型。
 *
 * 这里再兜一次 license 过滤 —— 注册表当前全是 commercial，
 * 但将来若有人图省事补了个 research 条目，这里能让它永远选不中，
 * 而不是等到产品上线才发现。
 */
function candidatesFor(kind: TaskKind): ModelSpec[] {
  return MODELS.filter((m) => m.kind === kind && m.license === 'commercial')
}

/**
 * 按任务类型与档位选模型。
 *
 * 不指定 tier 时选**质量最高**的那档 —— 这是当前的产品取向：
 * 先把效果做出来，成本不是首要约束。
 * 将来若要按用户等级分档，改这里的调用参数即可，不用动别处。
 */
export function resolveModel(kind: TaskKind, options: { tier?: ModelTier } = {}): ModelSpec {
  const candidates = candidatesFor(kind)

  if (candidates.length === 0) {
    throw new NoModelAvailableError(kind, '注册表中没有该类型且可商用的模型')
  }

  const byRankDesc = [...candidates].sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])

  if (!options.tier) {
    return byRankDesc[0]
  }

  const exact = candidates.find((m) => m.tier === options.tier)
  if (exact) return exact

  // 没有精确匹配时，退到**不高于**目标档位里最好的那个：
  // 用户要 budget 却只拿到 premium 会超预算，反过来只是效果差一点。
  const targetRank = TIER_RANK[options.tier]
  const atOrBelow = byRankDesc.find((m) => TIER_RANK[m.tier] <= targetRank)

  return atOrBelow ?? byRankDesc[byRankDesc.length - 1]
}

/**
 * 找一个更便宜的同类型模型，用于失败降级重试。
 * 没有更便宜的可用时返回 null —— 调用方据此决定是报错还是原样重试。
 */
export function resolveCheaperFallback(model: ModelSpec): ModelSpec | null {
  const cheaper = candidatesFor(model.kind)
    .filter((m) => m.costUsdPerRun < model.costUsdPerRun)
    .sort((a, b) => a.costUsdPerRun - b.costUsdPerRun)

  return cheaper[0] ?? null
}

/** 列出某类型的所有模型，供界面展示"用哪个模型/多少钱" */
export function listModels(kind: TaskKind): ModelSpec[] {
  return candidatesFor(kind).sort((a, b) => a.costUsdPerRun - b.costUsdPerRun)
}
