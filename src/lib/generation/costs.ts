import { and, eq, gte } from 'drizzle-orm'

import { db } from '@/lib/db'
import { generations, type GenerationStatus } from '@/lib/db/schema'
import type { TaskKind } from '@/lib/domain'
import { explainGenerationError } from '@/lib/generation/errors'
import { getModelById } from '@/lib/providers'

/**
 * 花了多少钱。
 *
 * ── 为什么不能只 `sum(cost_usd)` ──────────────────────────────
 * `generations.costUsd` **只在成功时写入**（见 `process.ts` 那一行：
 * "只记成功调用的成本"）。直接把这一列加起来会漏掉一整类**花了钱却没拿到图**的
 * 情况 —— 而 `errors.ts` 里 `output_download_failed` 的注释写得很清楚：
 * "上游那边图已生成并计费，只是我们没下载成功"。
 *
 * 漏掉它的后果比数字偏小严重得多：用户看到"这个月花了 $3"，而账单上是 $5，
 * 于是他会**不再相信这个看板**，然后回去翻 fal 的后台。
 * 一个数字对不上账的成本看板，还不如没有。
 *
 * ── 所以它复用同一个三态判断 ─────────────────────────────────
 * "这次失败到底计费没有"已经有一处权威答案：`explainGenerationError().cost`
 * （`none` / `charged` / `unknown`），那正是失败卡片上显示"是否已计费"用的东西。
 * 看板另判一套的话，同一笔失败在两处会给出不同说法 —— 而这种不一致
 * 用户一眼就能看见，代价是整个应用的信用。
 *
 * `unknown` **绝不并入总额**。猜一个数字进去就是撒谎，而这里撒谎的代价是
 * 用户据此做"要不要再试一次"的决定 —— 那正是要花钱的决定。
 */

export interface CostRow {
  modelId: string
  taskKind: TaskKind
  status: GenerationStatus
  costUsd: number | null
  errorCode: string | null
  errorMessage: string | null
}

export interface CostBreakdown {
  modelId: string
  /** 注册表里的中文名；模型已经下架时为 null */
  label: string | null
  succeeded: number
  /** 已知计费、但没有产出图的失败笔数 */
  chargedFailures: number
  chargedUsd: number
}

export interface CostSummary {
  /** 统计覆盖的时间起点。**总额永远与它一起展示** —— "共 $5" 与 "近 30 天 $5" 是两句话 */
  since: Date
  chargedUsd: number
  succeededCount: number
  /**
   * 花了钱却没拿到图的笔数。
   *
   * 单独列出来是因为它最该被看见：这些钱没有换来任何东西，
   * 而用户在结果区只看到一条"失败"，很容易以为没花钱。
   */
  chargedFailureCount: number
  /**
   * 无法确定是否计费的失败笔数。
   *
   * **不计入 `chargedUsd`，也不计为 0** —— 它是"可能有、可能没有"。
   * 把它说成 0 是误导，把它估成一个数则是编造。
   */
  uncertainCount: number
  byModel: CostBreakdown[]
}

/**
 * 汇总一批生成记录的花费。纯函数，价格通过 `costPerRunOf` 注入 ——
 * 于是"模型已经下架、价格查不到"这条分支可以直接被测到，
 * 而那正是最容易悄悄少算的一种情况。
 */
export function buildCostSummary(
  rows: CostRow[],
  costPerRunOf: (modelId: string) => number | null,
  since: Date,
): CostSummary {
  const byModel = new Map<string, CostBreakdown>()
  let chargedUsd = 0
  let chargedFailureCount = 0
  let uncertainCount = 0
  let succeededCount = 0

  const bucketFor = (modelId: string): CostBreakdown => {
    const existing = byModel.get(modelId)
    if (existing) return existing

    const created: CostBreakdown = {
      modelId,
      label: getModelById(modelId)?.label ?? null,
      succeeded: 0,
      chargedFailures: 0,
      chargedUsd: 0,
    }
    byModel.set(modelId, created)
    return created
  }

  for (const row of rows) {
    if (row.status === 'succeeded') {
      /*
       * 优先用行上记着的实际成本，回退到注册表的价格。
       *
       * 回退是必要的：历史行、或将来别的写入方可能没写 costUsd，
       * 而那一行确实花掉了钱。取不到价格时**不加 0** —— 加 0 等于
       * 宣称"这次没花钱"，而事实是我们不知道。
       */
      const amount = row.costUsd ?? costPerRunOf(row.modelId)

      if (amount === null) {
        uncertainCount += 1
        continue
      }

      chargedUsd += amount
      succeededCount += 1
      const bucket = bucketFor(row.modelId)
      bucket.succeeded += 1
      bucket.chargedUsd += amount
      continue
    }

    if (row.status !== 'failed') continue

    // 与失败卡片同源。这个判断不改，看板就不会和卡片打架
    const impact = explainGenerationError(row.errorCode, row.errorMessage)?.cost

    if (impact === 'none' || impact === undefined) continue

    if (impact === 'unknown') {
      uncertainCount += 1
      continue
    }

    // impact === 'charged'：上游已经计费，只是我们没拿到图
    const amount = costPerRunOf(row.modelId)

    if (amount === null) {
      // 价格查不到（模型已下架）。**不能按 0 记账** ——
      // 变异检验记录：把它记进 chargedFailureCount 而不进 uncertain，
      // 上面那条断言会以 `expected 1 to be +0` 变红。
      uncertainCount += 1
      continue
    }

    chargedUsd += amount
    chargedFailureCount += 1
    const bucket = bucketFor(row.modelId)
    bucket.chargedFailures += 1
    bucket.chargedUsd += amount
  }

  return {
    since,
    chargedUsd,
    succeededCount,
    chargedFailureCount,
    uncertainCount,
    byModel: [...byModel.values()].sort((a, b) => b.chargedUsd - a.chargedUsd),
  }
}

/** 默认统计窗口。无界扫描会让这个查询随使用时间线性变慢，而它每次问都要跑 */
export const DEFAULT_WINDOW_DAYS = 30

export interface CostSummaryOptions {
  /** 往前看多少天，默认 30 */
  days?: number
  /** 便于测试注入固定的"现在" */
  now?: Date
}

/**
 * 查本会话在时间窗口内的花费。
 *
 * `sessionId` 必填而不是可选，理由同 `listRecentResults`：
 * 没有任何合理场景需要跨会话查询 —— 而这一个更敏感，
 * 算错就是把别人的开销显示给你。
 */
export async function getCostSummary(
  sessionId: string,
  { days = DEFAULT_WINDOW_DAYS, now = new Date() }: CostSummaryOptions = {},
): Promise<CostSummary> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

  const rows = await db
    .select({
      modelId: generations.modelId,
      taskKind: generations.taskKind,
      status: generations.status,
      costUsd: generations.costUsd,
      errorCode: generations.errorCode,
      errorMessage: generations.errorMessage,
    })
    .from(generations)
    .where(
      and(eq(generations.sessionId, sessionId), gte(generations.createdAt, since)),
    )

  return buildCostSummary(
    rows,
    (modelId) => getModelById(modelId)?.costUsdPerRun ?? null,
    since,
  )
}
