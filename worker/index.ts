/**
 * 生成任务 worker 的进程入口 —— 独立进程，不在 Next.js 里跑。
 *
 * 为什么必须独立：一次生成要占住一个执行槽几十秒（提交 + 轮询上游），
 * 放进 Web 进程会占满请求处理能力，也让"重启 web 不影响进行中的任务"变得不可能。
 *
 * 启动方式（任选）：
 *   ./node_modules/.bin/tsx worker/index.ts
 *   npm run worker
 *
 * 本文件只负责进程级的事（信号处理、退出码）；队列装配在
 * `@/lib/queue/run-worker` 里，以便被测试直接调用。
 */
import { startWorker } from '@/lib/queue/run-worker'
import { stopBoss } from '@/lib/queue/boss'

/** 优雅退出：等正在跑的任务收尾，避免任务卡在 processing 到超时 */
async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] 收到 ${signal}，正在停止…`)
  try {
    await stopBoss()
    console.log('[worker] 已停止')
    process.exit(0)
  } catch (error) {
    console.error('[worker] 停止时出错：', error)
    process.exit(1)
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal)
  })
}

startWorker().catch((error) => {
  console.error('[worker] 启动失败：', error)
  process.exit(1)
})
