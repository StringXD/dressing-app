import { eq, notInArray } from 'drizzle-orm'

import { db } from '@/lib/db'
import { generations, TERMINAL_STATUSES } from '@/lib/db/schema'
import { GENERATION_QUEUE, getBoss } from '@/lib/queue/boss'
import type { GenerationJobData } from '@/lib/queue/enqueue'

export interface ReconcileResult {
  /** 被从"孤儿 processing"退回 queued 的数量 */
  reset: number
  /** 本次真正投递出去的消息数 */
  sent: number
  /** 队列里本就有一条待处理消息、因而跳过的数量 */
  alreadyQueued: number
}

/**
 * worker 启动时的对账。这是崩溃恢复的兜底，补上"DB 行与队列消息不原子"的缺口。
 *
 * 做两件事：
 *  1. 把孤儿 `processing` 退 `queued`。单 worker 部署下，启动这一刻不可能有任务
 *     真的在跑，所以还停在 processing 的一定是上次进程被杀留下的。
 *     ⚠️ 多 worker 部署时这一步会误伤别的实例正在处理的任务 —— 那时需要按
 *     worker 实例 id 或心跳时间戳来判定，当前先不做。
 *  2. 给**确实没有队列消息**的非终态任务补发一条。
 *
 * 第 2 步必须先查再发，不能无脑重发：pg-boss 把任务存在 Postgres 里，
 * worker 崩了任务仍在队列中，多数情况下压根不需要补。无脑重发会让队列里
 * 每个待办任务都多出一条影子消息 —— 虽然认领逻辑能保证不重复扣费，
 * 但会让并发槽被空转的消息占掉，队位也对不上。
 *
 * 判重靠 `findJobs({ key, queued: true })`（`queued` 对应 `state < 'active'`，
 * 即 created / retry）。**不能**靠 `singletonKey`：pg-boss 的 singleton 约束由
 * 按队列 policy 过滤的部分唯一索引实现，standard 策略下不生效（已核对 dist/plans.js）。
 */
export async function reconcileOnStartup(): Promise<ReconcileResult> {
  const resetRows = await db
    .update(generations)
    .set({ status: 'queued', updatedAt: new Date() })
    .where(eq(generations.status, 'processing'))
    .returning({ id: generations.id })

  const pending = await db
    .select({ id: generations.id })
    .from(generations)
    .where(notInArray(generations.status, [...TERMINAL_STATUSES]))

  if (pending.length === 0) {
    return { reset: resetRows.length, sent: 0, alreadyQueued: 0 }
  }

  const boss = await getBoss()
  let sent = 0
  let alreadyQueued = 0

  for (const row of pending) {
    const existing = await boss.findJobs(GENERATION_QUEUE, { key: row.id, queued: true })

    if (existing.length > 0) {
      alreadyQueued += 1
      continue
    }

    await boss.send(
      GENERATION_QUEUE,
      { generationId: row.id } satisfies GenerationJobData,
      { singletonKey: row.id },
    )
    sent += 1
  }

  return { reset: resetRows.length, sent, alreadyQueued }
}
