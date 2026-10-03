import { ApiError, fal } from '@fal-ai/client'

import { requireEnv } from '@/lib/env'

import type { ImageInput, ModelSpec, PollResult, ProviderAdapter, TaskInput } from '../types'
import { getImageFields, mapParams } from './paramMap'

/**
 * 只声明我们实际用到的那部分 fal client 接口。
 *
 * 这样单测可以注入一个假的 client，完全不需要打网络；
 * 也避免把整个 @fal-ai/client 的类型面耦合进来。
 */
export interface FalClientLike {
  config(config: { credentials: string }): void
  storage: {
    upload(file: Blob): Promise<string>
  }
  queue: {
    submit(
      endpoint: string,
      options: { input: Record<string, unknown> },
    ): Promise<{ request_id: string }>
    status(endpoint: string, options: { requestId: string }): Promise<{ status: string }>
    result(endpoint: string, options: { requestId: string }): Promise<{ data: unknown }>
  }
}

/**
 * 从上游返回体里取图片 URL。
 *
 * 三个端点（试穿 v1.6、通用试穿、换发型）的输出结构一致，都是
 * `{ images: [{ url }] }`，所以一个提取器够用。
 * 若将来接入输出结构不同的端点，把这里改成按端点分派即可。
 */
export function extractImageUrl(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`上游返回体不是对象：${typeof raw}`)
  }

  const images = (raw as { images?: unknown }).images
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('上游返回体中没有 images 数组或其为空')
  }

  const first = images[0] as { url?: unknown }
  if (typeof first?.url !== 'string' || first.url.length === 0) {
    throw new Error('上游返回的 images[0] 缺少 url 字段')
  }

  return first.url
}

/**
 * 把上游的错误体整理成一句有用的话。
 *
 * 只报一个 "Unprocessable Entity" 基本等于没说 —— fal 的真正原因
 * （哪个字段非法、图片为什么被拒）全在 body 里。实测踩过这个坑：
 * FASHN 提交成功但处理阶段 422，没有 body 就完全无从判断是参数问题还是图片问题。
 *
 * fal 的校验错误形如 `{ detail: [{ loc: [...], msg: "...", type: "..." }] }`，
 * 把 loc 与 msg 提出来即可；其它形状退回截断的 JSON。
 */
export function describeErrorBody(body: unknown): string {
  if (body === undefined || body === null) return ''

  if (typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail

    if (Array.isArray(detail)) {
      const messages = detail
        .map((item) => {
          if (typeof item !== 'object' || item === null) return String(item)
          const { loc, msg } = item as { loc?: unknown; msg?: unknown }
          const where = Array.isArray(loc) ? loc.join('.') : ''
          return where ? `${where}: ${String(msg ?? '')}` : String(msg ?? '')
        })
        .filter(Boolean)

      if (messages.length > 0) return ` — ${messages.join('; ').slice(0, 400)}`
    }

    if (typeof detail === 'string' && detail) return ` — ${detail.slice(0, 400)}`
  }

  try {
    return ` — ${JSON.stringify(body).slice(0, 400)}`
  } catch {
    return ''
  }
}

export function createFalAdapter(client: FalClientLike = fal): ProviderAdapter {
  let configured = false

  /**
   * 延迟到真正调用时才校验 Key —— 让骨架、界面、单测在没有 Key 的情况下也能跑。
   */
  function ensureConfigured(): void {
    if (configured) return
    client.config({ credentials: requireEnv('FAL_KEY') })
    configured = true
  }

  /**
   * 把图片字节送到 fal 的存储，换回一个上游可抓取的 URL。
   *
   * 这一步不可省：我们的图片在 `/api/files/*` 后面，需要会话 cookie 才能读，
   * 直接把自家 URL 交给 fal 只会拿到 404。
   */
  async function uploadImage(image: ImageInput): Promise<string> {
    const blob = new Blob([new Uint8Array(image.bytes)], { type: image.mime })
    return client.storage.upload(blob)
  }

  return {
    id: 'fal',

    async submit(model: ModelSpec, input: TaskInput) {
      ensureConfigured()

      const fields = getImageFields(model.endpoint)

      const personUrl = await uploadImage(input.person)

      // 只有试穿类端点需要服装图；换发型多传一次纯属浪费一轮往返
      let garmentUrl: string | undefined
      if (fields.garmentField && input.kind === 'tryon') {
        garmentUrl = await uploadImage(input.garment)
      }

      const falInput = mapParams(model.endpoint, input, {
        person: personUrl,
        garment: garmentUrl,
      })

      const queued = await client.queue.submit(model.endpoint, { input: falInput })
      return { providerJobId: queued.request_id }
    },

    async poll(model: ModelSpec, providerJobId: string): Promise<PollResult> {
      ensureConfigured()

      let status: { status: string }
      try {
        status = await client.queue.status(model.endpoint, { requestId: providerJobId })
      } catch (error) {
        return {
          state: 'failed',
          code: error instanceof ApiError ? `http_${error.status}` : 'status_request_failed',
          message: error instanceof Error ? error.message : String(error),
        }
      }

      if (status.status !== 'COMPLETED') {
        // IN_QUEUE / IN_PROGRESS 都算还没好。注意 fal 侧也有队列，
        // 所以"我们提交成功"不等于"上游开始跑了"。
        return { state: 'pending' }
      }

      // 到了 COMPLETED 才去取结果 —— 上游的失败是在这一步才暴露的，
      // status 本身只有 IN_QUEUE / IN_PROGRESS / COMPLETED 三种，不含失败态。
      try {
        const result = await client.queue.result(model.endpoint, { requestId: providerJobId })
        return { state: 'succeeded', raw: result.data }
      } catch (error) {
        if (error instanceof ApiError) {
          return {
            state: 'failed',
            code: error.isUserTimeout ? 'user_timeout' : `http_${error.status}`,
            message: `${error.message}${describeErrorBody(error.body)}`,
          }
        }
        return {
          state: 'failed',
          code: 'result_request_failed',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    },

    normalizeResult(_model: ModelSpec, raw: unknown) {
      return { imageUrl: extractImageUrl(raw) }
    },
  }
}
