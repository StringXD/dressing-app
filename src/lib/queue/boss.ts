import { PgBoss, type Queue } from 'pg-boss'

import { env } from '@/lib/env'

/** 生成任务的队列名。目前只有这一条队列，将来加别的（清理、解析）时并列即可。 */
export const GENERATION_QUEUE = 'generation'

/**
 * 队列配置。
 *
 * ⚠️ pg-boss 的 `create_queue` 是 `ON CONFLICT DO NOTHING`（已核对 plans.js 的 DDL），
 * 所以这些值**只在队列首次创建时生效**。改了这里却发现线上行为没变时，
 * 用 `boss.updateQueue()` 或直接删表重建，别怀疑人生。
 */
const QUEUE_OPTIONS = {
  // 失败重试 1 次。多数失败是上游 5xx 或内容风控，
  // 内容风控重试无用，5xx 有一次机会够了；真正需要换档降级的是阶段 8 的事。
  retryLimit: 1,
  retryDelay: 10,

  // 一个任务从被领取到必须完成的上限。换装/换发型通常几十秒，
  // 900 秒是为上游排队留足余量 —— 太短会把还在正常跑的任务判死并重跑，白花钱。
  expireInSeconds: 900,

  // 未被领取的任务保留 1 天。超过基本说明 worker 没在跑，留着也没意义。
  retentionSeconds: 86_400,

  // 完成的任务保留 1 天，便于排查"为什么这张图长这样"。
  deleteAfterSeconds: 86_400,
} satisfies Omit<Queue, 'name'>

/**
 * Next.js 开发模式下模块会随热重载反复求值，必须缓存实例，
 * 否则每次改代码都新建一个 pg-boss（含连接池与后台轮询）。
 */
const globalForBoss = globalThis as unknown as { __dressingBoss?: Promise<PgBoss> }

async function startBoss(): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    // 让 pg_stat_activity 里能一眼认出是谁的连接
    application_name: 'dressing-app',
  })

  // pg-boss 用事件而非抛异常报告内部故障（连接抖动、维护任务失败等），
  // 不监听会变成未处理的 error 事件直接把进程带崩。
  boss.on('error', (error) => {
    console.error('[pg-boss] 内部错误：', error)
  })

  await boss.start()

  // 幂等：队列已存在时 ON CONFLICT DO NOTHING，因此可以每次启动都调
  await boss.createQueue(GENERATION_QUEUE, QUEUE_OPTIONS)

  return boss
}

/**
 * 取已启动的 PgBoss 实例。
 *
 * 缓存的是 Promise 而非实例，这样并发调用只会启动一次。
 */
export function getBoss(): Promise<PgBoss> {
  if (!globalForBoss.__dressingBoss) {
    const starting = startBoss()

    // 启动失败时必须清掉缓存：留下一个 rejected 的 Promise 会让后续每一次调用
    // 都拿到同一个错误，进程再也恢复不了。
    starting.catch(() => {
      if (globalForBoss.__dressingBoss === starting) {
        globalForBoss.__dressingBoss = undefined
      }
    })

    globalForBoss.__dressingBoss = starting
  }

  return globalForBoss.__dressingBoss
}

/** 优雅关闭。worker 退出前调用，等正在跑的任务收尾。 */
export async function stopBoss(): Promise<void> {
  const boss = await globalForBoss.__dressingBoss
  if (!boss) return

  globalForBoss.__dressingBoss = undefined
  await boss.stop({ graceful: true, timeout: 30_000 })
}
