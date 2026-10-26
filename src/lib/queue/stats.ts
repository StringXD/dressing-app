import { and, count, desc, eq, inArray, lt } from 'drizzle-orm'

import { db } from '@/lib/db'
import { generations, TERMINAL_STATUSES, type GenerationStatus } from '@/lib/db/schema'
import { explainGenerationError, type ErrorExplanation } from '@/lib/generation/errors'
import { generationQueue, getBoss } from './boss'

/** 还在队伍里的状态。终态的任务不再占位。 */
const ACTIVE_STATUSES: readonly GenerationStatus[] = ['queued', 'processing']

/**
 * "刷新后还剩什么"最多列这么多条。
 *
 * 上限不是洁癖：下面每一条都要单独查一次队位，而未结束的任务
 * 在 `batchSize=1` 的队列里本来就不会多。真要显示更多，
 * 该改的是队位的算法（一次查出来），不是把这个数字调大。
 */
const MAX_ACTIVE_LIST = 20

export interface QueueStats {
  /** 等待被领取 */
  queued: number
  /** 已被 worker 领取，正在生成 */
  processing: number
  succeeded: number
  failed: number
  canceled: number
}

export interface GenerationQueueInfo {
  status: GenerationStatus
  /**
   * 我前面还有几个任务。
   * 终态任务恒为 0 —— 前端据此决定是否停止轮询。
   */
  position: number
  /** 自己是否仍会被处理（queued 或 processing） */
  active: boolean
  /**
   * 失败原因的中文解释，由 `(errorCode, errorMessage)` 推导而来（见 `generation/errors.ts`）。
   * 没失败过时为 undefined。
   *
   * **刻意不暴露 errorMessage 原文**：那是给排查用的上游英文，
   * 不该出现在面向用户的接口里。要原文就去查 DB。
   */
  error?: ErrorExplanation
}

/**
 * 队列概览。
 *
 * 传 sessionId 则只统计该会话的任务（界面用），不传则是全局（运维用）。
 * **队位始终是全局的** —— 排队排的是所有人的任务，只按自己人算会给出
 * 一个乐观到失真的数字。
 */
export async function getQueueStats(sessionId?: string): Promise<QueueStats> {
  const rows = await db
    .select({ status: generations.status, value: count() })
    .from(generations)
    .where(sessionId ? eq(generations.sessionId, sessionId) : undefined)
    .groupBy(generations.status)

  // count() 经 node-postgres 回来是 bigint（字符串），必须显式转数字，
  // 否则 `queued === 0` 这类判断会因为 '0' !== 0 而静默失效
  const byStatus = new Map(rows.map((r) => [r.status, Number(r.value)]))

  return {
    queued: byStatus.get('queued') ?? 0,
    processing: byStatus.get('processing') ?? 0,
    succeeded: byStatus.get('succeeded') ?? 0,
    failed: byStatus.get('failed') ?? 0,
    canceled: byStatus.get('canceled') ?? 0,
  }
}

/**
 * 某个任务前面还有几个。
 *
 * 队位靠 queueSeq（bigserial，全局单调）比较，而不是时间戳 ——
 * 并发写入下时间戳可能相同，序列号不会。
 *
 * 返回 null 表示任务不存在（可能已被删除，或 id 拼错了）。
 */
export async function getGenerationQueueInfo(
  generationId: string,
): Promise<GenerationQueueInfo | null> {
  const [self] = await db
    .select({
      status: generations.status,
      queueSeq: generations.queueSeq,
      errorCode: generations.errorCode,
      errorMessage: generations.errorMessage,
    })
    .from(generations)
    .where(eq(generations.id, generationId))
    .limit(1)

  if (!self) return null

  // 只在确实失败过时才有解释；成功的任务 errorCode 为空，这里就是 undefined
  const error = explainGenerationError(self.errorCode, self.errorMessage) ?? undefined

  const active = ACTIVE_STATUSES.includes(self.status)

  if (!active) {
    return { status: self.status, position: 0, active: false, error }
  }

  // 排在前面且仍在队伍里的才算数：已经结束的任务不占位。
  // FIFO + batchSize=1 意味着正在 processing 的任务必然 seq 更小，所以这样数是对的。
  const [aheadRow] = await db
    .select({ value: count() })
    .from(generations)
    .where(
      and(inArray(generations.status, [...ACTIVE_STATUSES]), lt(generations.queueSeq, self.queueSeq)),
    )

  return {
    status: self.status,
    position: Number(aheadRow?.value ?? 0),
    active: true,
    error,
  }
}

export interface GenerationQueueItem extends GenerationQueueInfo {
  id: string
}

/**
 * 批量取多个任务的队位，供批量网格与队列面板使用。
 *
 * 带 sessionId 做**归属校验**：不校验的话，任何人都能用一串 id 探测
 * 别人任务的进度与成败。不属于该会话的 id 直接不出现在结果里
 * （而不是报错 —— 那会让"某个 id 已被删除"和"不是你的"变得可区分）。
 */
export async function getQueueItems(
  sessionId: string,
  ids: string[],
): Promise<GenerationQueueItem[]> {
  const owned = await db
    .select({ id: generations.id })
    .from(generations)
    .where(and(inArray(generations.id, ids), eq(generations.sessionId, sessionId)))

  const items = await Promise.all(
    owned.map(async ({ id }) => {
      const info = await getGenerationQueueInfo(id)
      return info ? { id, ...info } : null
    }),
  )

  return items.filter((item): item is GenerationQueueItem => item !== null)
}

export interface ActiveGeneration extends GenerationQueueItem {
  /** 入队时刻（ISO 串）。前端据此显示"已经等了多久" */
  createdAt: string
}

/**
 * 某个会话当前**未结束**的任务，最新的在前。
 *
 * 存在理由是修一个真实缺口：进度面板的任务列表来自前端内存里的对话消息，
 * 一刷新就空了 —— 于是一次正在跑的换装会在界面上彻底消失，用户只能
 * 反复刷新碰运气。结果区也覆盖不到它：那里只列终态。
 *
 * "刷新之后还剩什么"这个问题，必须由服务端回答 —— 客户端的记忆正是丢掉的那部分。
 *
 * 队位复用 `getGenerationQueueInfo` 而不在这里另算一遍："前面还有几个"
 * 只能有一种定义，两个实现迟早会对不上。
 */
export async function listActiveGenerations(
  sessionId: string,
  limit = MAX_ACTIVE_LIST,
): Promise<ActiveGeneration[]> {
  const rows = await db
    .select({ id: generations.id, createdAt: generations.createdAt })
    .from(generations)
    .where(
      and(eq(generations.sessionId, sessionId), inArray(generations.status, [...ACTIVE_STATUSES])),
    )
    .orderBy(desc(generations.queueSeq))
    .limit(limit)

  const items = await Promise.all(
    rows.map(async (row) => {
      const info = await getGenerationQueueInfo(row.id)
      // 理论上不会为 null（行刚查到），但并发下任务可能刚好结束并被删除
      return info ? { id: row.id, createdAt: row.createdAt.toISOString(), ...info } : null
    }),
  )

  return items.filter((item): item is ActiveGeneration => item !== null)
}

/**
 * pg-boss 视角的队列健康度。
 *
 * 与上面按业务统计的 getQueueStats 互为交叉验证：两者数量长期对不上，
 * 说明有任务落库了但没进队列（或反之），属于必须报警的异常。
 *
 * 用 Number() 包一层不是多余的谨慎：底层 SQL 函数返回 bigint，
 * 而 node-postgres 默认把 bigint 解析成**字符串**，
 * 于是这里声明成 number 的字段有可能实际拿到 "0" 这种值。
 */
export async function getBossQueueHealth(): Promise<{
  total: number
  deferred: number
  ready: number
  active: number
} | null> {
  const boss = await getBoss()
  const [row] = await boss.getQueueStats(generationQueue())

  if (!row) return null

  return {
    total: Number(row.totalCount),
    deferred: Number(row.deferredCount),
    ready: Number(row.readyCount),
    active: Number(row.activeCount),
  }
}

/** 终态判定，状态机会在此停住 */
export function isTerminal(status: GenerationStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}
