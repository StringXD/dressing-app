/**
 * 验收测试专用的 worker 子进程。
 *
 * 它跑的是**真实的** `startWorker()` 装配（对账、并发上限、认领、pg-boss 消费者），
 * 只把"调上游"这一段换成假 provider。这样并发上限、FIFO、崩溃恢复这些性质
 * 测的是真代码，而不是一个复刻品。
 *
 * 环境变量：
 *   STUB_LATENCY_MS     每个任务耗时（默认 800），用来制造可观测的并发重叠
 *   STUB_FAIL_DOWNLOADS 前 N 次下载产物时失败（默认 0），用来制造可重试失败
 */
import { processGeneration, type ProcessOptions, type ProcessOutcome } from '@/lib/generation/process'
import { stopBoss } from '@/lib/queue/boss'
import { startWorker } from '@/lib/queue/run-worker'

import { createStubAdapter, createStubFetch, EVENT_MARKER } from './lib/stub-provider'

const latencyMs = Number(process.env.STUB_LATENCY_MS ?? 800)
const failDownloads = Number(process.env.STUB_FAIL_DOWNLOADS ?? 0)

const adapter = createStubAdapter({ latencyMs })
const fetchImpl = createStubFetch({ failDownloads })

/** 同时在进行生成的任务数 —— 这就是要验证的那个并发量 */
let inFlight = 0

function emit(event: Record<string, unknown>): void {
  console.log(EVENT_MARKER + JSON.stringify(event))
}

/** 名字不要叫 process —— 那会遮住 Node 的全局 process 对象 */
async function processWithStub(
  generationId: string,
  options: ProcessOptions,
): Promise<ProcessOutcome> {
  inFlight += 1
  emit({ event: 'start', generationId, inFlight, at: Date.now() })

  try {
    const outcome = await processGeneration(generationId, {
      ...options,
      adapter,
      fetchImpl,
      // 桩的延迟远小于 2 秒，缩短轮询间隔以免测试时间被轮询节奏主导
      pollIntervalMs: 100,
    })

    emit({ event: 'end', generationId, outcome: outcome.status, at: Date.now() })
    return outcome
  } finally {
    inFlight -= 1
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void stopBoss().finally(() => process.exit(0))
  })
}

startWorker({ process: processWithStub })
  .then(() => {
    emit({ event: 'ready' })
  })
  .catch((error) => {
    console.error('[worker-stub] 启动失败：', error)
    process.exit(1)
  })
