import { env } from '@/lib/env'
import {
  processGeneration,
  type ProcessOptions,
  type ProcessOutcome,
} from '@/lib/generation/process'
import { reconcileOnStartup } from '@/lib/generation/reconcile'
import { licenseWarningText } from '@/lib/providers/registry'

import { generationQueue, getBoss, QUEUE_OPTIONS } from './boss'
import type { GenerationJobData } from './enqueue'

/**
 * 处理一个任务的函数签名。
 *
 * 抽成参数是为了让验收测试能跑**真实的 worker 装配**（队列、并发、认领、对账）
 * 而只替换掉"调上游"这一段 —— 既避免在产线代码里塞测试开关，
 * 也避免为了测并发而真的花钱。
 */
export type ProcessFn = (
  generationId: string,
  options: ProcessOptions,
) => Promise<ProcessOutcome>

export interface StartWorkerOptions {
  process?: ProcessFn
}

/**
 * 启动 worker：对账 → 注册消费者。
 *
 * 独立于 `worker/index.ts`，因为入口文件里有进程信号处理与 `process.exit`，
 * 被测试 import 会很难缠。这里只做纯粹的业务装配。
 */
export async function startWorker(options: StartWorkerOptions = {}): Promise<void> {
  const processFn = options.process ?? processGeneration

  // 政策允许收录禁商用的 research 条目（效果优先），代价是**必须让人知道**。
  // 放在启动路径而不是只写进 README：真正会踩坑的是直接 clone 就跑起来的人，
  // 他们不会去翻文档，但一定会看到启动日志。
  const licenseWarning = licenseWarningText()
  if (licenseWarning) console.warn(`[worker] 模型授权警告：\n${licenseWarning}`)

  const boss = await getBoss()

  // 先对账再开始领任务：顺序反了的话，对账重新投递的消息会在
  // 老任务还在跑时被领走（虽然认领幂等，但会白跑一轮）
  const { reset, sent, alreadyQueued } = await reconcileOnStartup()
  console.log(
    `[worker] 对账完成：孤儿任务退回 ${reset} 个，补投 ${sent} 个，` +
      `队列中已有消息因而跳过 ${alreadyQueued} 个`,
  )

  await boss.work<GenerationJobData>(
    generationQueue(),
    {
      // 每次只领 1 个。**不要调大**：handler 抛错会让整批任务一起失败重试，
      // batchSize 为 1 才能让失败只影响自己。
      batchSize: 1,
      // 并发上限直接对齐 fal 账户额度：设大了会互相排队，设小了浪费吞吐
      localConcurrency: env.FAL_CONCURRENCY,
    },
    async (jobs) => {
      for (const job of jobs) {
        const { generationId } = job.data
        const attempt = job.retryCount + 1

        // pg-boss 的 retryCount 从 0 起算，每次**领取**时递增
        // （已核对 dist/plans.js：`retry_count = CASE WHEN started_on IS NOT NULL
        // THEN retry_count + 1 ELSE retry_count END`），失败时它用
        // `retry_count < retry_limit` 判断还有没有下一次。
        // 所以 `retryCount >= retryLimit` 恰好是"这是最后一次尝试"。
        const isFinalAttempt = job.retryCount >= QUEUE_OPTIONS.retryLimit

        try {
          const outcome = await processFn(generationId, {
            signal: job.signal,
            isFinalAttempt,
          })

          if (outcome.status === 'succeeded') {
            console.log(`[worker] ${generationId} 成功 → asset ${outcome.outputAssetId}`)
          } else if (outcome.status === 'failed') {
            // 失败已被写进 DB，属于正常收尾，不该让队列再重试
            console.warn(`[worker] ${generationId} 失败：${outcome.code} ${outcome.message}`)
          } else {
            console.log(`[worker] ${generationId} 跳过：${outcome.reason}`)
          }
        } catch (error) {
          // processGeneration 只在可重试失败时抛出。重新抛出交给 pg-boss
          // 记录这次尝试并按 retryLimit 安排重试。
          console.error(
            `[worker] ${generationId} ${
              isFinalAttempt ? '最终失败，重试预算已用尽' : '可重试失败'
            }（第 ${attempt} 次）：`,
            error instanceof Error ? error.message : error,
          )
          throw error
        }
      }
    },
  )

  console.log(`[worker] 就绪：队列 ${generationQueue()}，并发上限 ${env.FAL_CONCURRENCY}`)
}
