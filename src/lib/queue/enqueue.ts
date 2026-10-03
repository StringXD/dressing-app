import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { generations, type Generation } from '@/lib/db/schema'
import type { TaskKind } from '@/lib/domain'
import type { ModelSpec } from '@/lib/providers'

import { GENERATION_QUEUE, getBoss } from './boss'
import type { GenerationParams } from '@/lib/generation/params'

/** worker 从任务数据里读到的内容。刻意只放 id —— 其余状态一律以 DB 为准。 */
export interface GenerationJobData {
  generationId: string
}

export interface EnqueueGenerationArgs {
  sessionId: string
  conversationId?: string | null
  taskKind: TaskKind
  /** 决定 providerId / modelId / costUsd 的记账依据 */
  model: ModelSpec
  personAssetId: string
  /** 换装必填，换发型为 null */
  garmentId?: string | null
  params: GenerationParams
}

/**
 * 建一条生成任务并入队。
 *
 * **写入顺序是刻意的：先落 DB 行，再发队列消息。**
 * 两个系统之间没有分布式事务，只能选一种中间态：
 *  - 先发队列：worker 拿到一个查不到的 id → 任务凭空消失，无从恢复
 *  - 先落行  ：留下一条 `queued` 但没人处理的记录 → 启用时的对账能把它捞回来
 * 因此先落行。worker 启动时的对账逻辑见 `reconcileOnStartup()`。
 */
export async function enqueueGeneration(args: EnqueueGenerationArgs): Promise<Generation> {
  const id = crypto.randomUUID()

  const [created] = await db
    .insert(generations)
    .values({
      id,
      sessionId: args.sessionId,
      conversationId: args.conversationId ?? null,
      taskKind: args.taskKind,
      status: 'queued',
      providerId: args.model.providerId,
      modelId: args.model.id,
      personAssetId: args.personAssetId,
      garmentId: args.garmentId ?? null,
      // 只存非图片参数；图片以 asset 引用存在，worker 开工时去存储层取字节
      params: args.params as Record<string, unknown>,
    })
    .returning()

  try {
    const boss = await getBoss()

    // singletonKey 只是**标记**，不构成约束。
    // pg-boss 的 singleton 去重靠按 policy 过滤的部分唯一索引实现
    // （见 dist/plans.js 的 job_i1…job_i8），而我们的队列是 standard 策略，
    // 那些索引不适用 —— 实测对账时重复投递确实产生了。留着它是为了在
    // pg-boss 的表里一眼看出这条消息属于哪个任务。
    //
    // 真正的防重复扣费在 claimGeneration()：只认领 queued，见那里的注释。
    const jobId = await boss.send(
      GENERATION_QUEUE,
      { generationId: id } satisfies GenerationJobData,
      { singletonKey: id },
    )

    if (!jobId) {
      // pg-boss 在队列不存在等情况下会静默返回 null 而不抛错
      throw new Error('pg-boss 未返回 job id（队列可能不存在）')
    }
  } catch (error) {
    // 入队失败必须把行标成失败：否则它会永远停在 queued，
    // 前端看到一个永远在排队的任务，而对账逻辑会反复重试一个注定失败的任务。
    const message = error instanceof Error ? error.message : String(error)

    await db
      .update(generations)
      .set({
        status: 'failed',
        errorCode: 'enqueue_failed',
        errorMessage: message,
        updatedAt: new Date(),
      })
      .where(eq(generations.id, id))

    throw error
  }

  return created
}
