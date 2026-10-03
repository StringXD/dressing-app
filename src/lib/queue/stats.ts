import { and, count, eq, inArray, lt } from 'drizzle-orm'

import { db } from '@/lib/db'
import { generations, TERMINAL_STATUSES, type GenerationStatus } from '@/lib/db/schema'
import { GENERATION_QUEUE, getBoss } from './boss'

/** 还在队伍里的状态。终态的任务不再占位。 */
const ACTIVE_STATUSES: readonly GenerationStatus[] = ['queued', 'processing']

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
    .select({ status: generations.status, queueSeq: generations.queueSeq })
    .from(generations)
    .where(eq(generations.id, generationId))
    .limit(1)

  if (!self) return null

  const active = ACTIVE_STATUSES.includes(self.status)

  if (!active) {
    return { status: self.status, position: 0, active: false }
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
  const [row] = await boss.getQueueStats(GENERATION_QUEUE)

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
