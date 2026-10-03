/**
 * 验收测试用的假 provider。
 *
 * 存在的理由：在没有 fal Key 的情况下，队列的并发上限、FIFO 顺序、崩溃恢复
 * 这些性质**完全无法验证**。一个可控延迟的假 provider 让这些性质变得可观测。
 *
 * 刻意放在 scripts/ 而非常产线代码里：产线不该有任何"可能忘了关掉"的开关。
 */
import sharp from 'sharp'

import type {
  ModelSpec,
  NormalizedOutput,
  PollResult,
  ProviderAdapter,
  SubmitResult,
  TaskInput,
} from '@/lib/providers'

/** 子进程用它把事件回传给父进程，避免与 worker 自己的日志混在一起 */
export const EVENT_MARKER = '#STUB#'

export interface StubAdapterOptions {
  /** 每个任务从 submit 到出结果的耗时，用来制造可观测的并发重叠 */
  latencyMs: number
  /** 已完成的任务数超过这个值后一律返回失败，用于测试失败路径 */
  failAfter?: number
}

/**
 * 从 providerJobId 里解出提交时刻；不是本桩生成的就返回 null。
 *
 * 刻意把时间编进 id 而不是存在进程内的 Map 里：worker 崩溃后重启用的是**新进程**，
 * 进程内状态会整个丢掉，于是"复用上游任务"这一行为在崩溃恢复场景下根本观察不到
 * —— 而崩溃恢复恰恰是最需要验证它的场景。id 对生产代码是不透明字符串，
 * 往里面编码信息是测试替身的合法自由。
 */
function parseSubmittedAt(providerJobId: string): number | null {
  const match = /^stub-(\d+)-/.exec(providerJobId)
  if (!match) return null

  const submittedAt = Number(match[1])
  return Number.isFinite(submittedAt) ? submittedAt : null
}

export function createStubAdapter(options: StubAdapterOptions): ProviderAdapter {
  /** 已被 poll 观察到出结果的任务数，只服务于 failAfter */
  let finished = 0

  function emit(event: Record<string, unknown>): void {
    console.log(EVENT_MARKER + JSON.stringify(event))
  }

  return {
    id: 'stub',

    async submit(_model: ModelSpec, input: TaskInput): Promise<SubmitResult> {
      const providerJobId = `stub-${Date.now()}-${crypto.randomUUID()}`

      emit({ event: 'submit', providerJobId, kind: input.kind })
      return { providerJobId }
    },

    async poll(_model: ModelSpec, providerJobId: string): Promise<PollResult> {
      const submittedAt = parseSubmittedAt(providerJobId)

      if (submittedAt === null) {
        return { state: 'failed', code: 'unknown_job', message: `未提交过 ${providerJobId}` }
      }

      if (Date.now() - submittedAt < options.latencyMs) {
        return { state: 'pending' }
      }

      // 出结果后**不清理**：真实上游会把结果保留一段时间，重复查询同一个任务是
      // 正常操作（重试恢复时正是这么做的）。清掉的话，复用上游任务在桩上会表现
      // 成 unknown_job，把"本该成功"的场景误判成失败。
      finished += 1

      if (options.failAfter !== undefined && finished > options.failAfter) {
        return { state: 'failed', code: 'content_rejected', message: '桩：模拟内容风控拒绝' }
      }

      return { state: 'succeeded', raw: { images: [{ url: 'https://stub.invalid/out.png' }] } }
    },

    normalizeResult(_model: ModelSpec, _raw: unknown): NormalizedOutput {
      return { imageUrl: 'https://stub.invalid/out.png' }
    },
  }
}

export interface StubFetchOptions {
  /**
   * 让前 N 次下载失败，用来制造 `output_download_failed`。
   *
   * 这个失败最尖锐：上游那边图已经生成好、也已经计过费，只是我们没拿到。
   * 如果重试时重新提交，就等于把一张已经付过钱的图丢掉再买一张。
   */
  failDownloads?: number
}

/**
 * 配合桩 provider 的 fetch：把 `https://stub.invalid/*` 变成一个真实的 PNG 字节流。
 *
 * 用 sharp 现场生成而不是塞一个 fixture 文件 —— 顺带验证了"上游返回的字节
 * 能一路过存储层"，同时也让内容可预期（纯色，便于断言）。
 */
export function createStubFetch(options: StubFetchOptions = {}): typeof fetch {
  let counter = 0
  let remainingFailures = options.failDownloads ?? 0

  return (async (input: RequestInfo | URL) => {
    const url = String(input)

    if (!url.startsWith('https://stub.invalid/')) {
      throw new Error(`桩 fetch 收到了预期外的 URL：${url}`)
    }

    if (remainingFailures > 0) {
      remainingFailures -= 1
      throw new Error('桩：模拟生成图下载失败')
    }

    counter += 1
    const bytes = await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 3,
        // 每次换一个颜色，便于确认不同任务的产物确实是各自独立的
        background: { r: 20 * counter, g: 60, b: 200 },
      },
    })
      .png()
      .toBuffer()

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })
  }) as typeof fetch
}
