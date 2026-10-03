import { ApiError } from '@fal-ai/client'
import { describe, expect, it } from 'vitest'

import type { HairInput, ImageInput, ModelSpec, TryOnInput } from '../types'
import { createFalAdapter, describeErrorBody, extractImageUrl, type FalClientLike } from './adapter'

const FASHN: ModelSpec = {
  id: 'fal/fashn-tryon-1.6',
  providerId: 'fal',
  endpoint: 'fal-ai/fashn/tryon/v1.6',
  kind: 'tryon',
  label: 'FASHN 试穿 v1.6',
  costUsdPerRun: 0.075,
  license: 'commercial',
  tier: 'premium',
}

const HAIR_MODEL: ModelSpec = {
  id: 'fal/hair-change',
  providerId: 'fal',
  endpoint: 'fal-ai/image-apps-v2/hair-change',
  kind: 'hair',
  label: '发型更换',
  costUsdPerRun: 0.04,
  license: 'commercial',
  tier: 'standard',
}

function image(name: string): ImageInput {
  return { bytes: Buffer.from(`bytes-of-${name}`), mime: 'image/webp', filename: `${name}.webp` }
}

const tryOnInput: TryOnInput = {
  kind: 'tryon',
  person: image('person'),
  garment: image('garment'),
  category: 'tops',
  mode: 'quality',
  garmentPhotoType: 'flat-lay',
}

const hairInput: HairInput = {
  kind: 'hair',
  person: image('person'),
  hairstyle: 'bob_cut',
  color: 'balayage',
}

/** 记录所有调用的假 client —— 单测不打网络 */
function fakeClient(options: { statusSequence?: string[]; resultError?: Error } = {}) {
  const uploads: { size: number; type: string }[] = []
  const submissions: { endpoint: string; input: Record<string, unknown> }[] = []
  const configs: { credentials: string }[] = []
  let statusCalls = 0

  const client: FalClientLike = {
    config(cfg) {
      configs.push(cfg)
    },
    storage: {
      async upload(file: Blob) {
        uploads.push({ size: file.size, type: file.type })
        // 用下标区分不同图片，便于断言上传顺序与归属
        return `https://fal.media/upload-${uploads.length - 1}.webp`
      },
    },
    queue: {
      async submit(endpoint, opts) {
        submissions.push({ endpoint, input: opts.input })
        return { request_id: 'req-123' }
      },
      async status() {
        const sequence = options.statusSequence ?? ['COMPLETED']
        const value = sequence[Math.min(statusCalls, sequence.length - 1)]
        statusCalls += 1
        return { status: value }
      },
      async result() {
        if (options.resultError) throw options.resultError
        return { data: { images: [{ url: 'https://fal.media/out.webp' }] } }
      },
    },
  }

  return { client, uploads, submissions, configs }
}

describe('FalAdapter.submit', () => {
  it('试穿任务上传人物图与服装图，并把 URL 按端点字段名塞进请求体', async () => {
    const { client, uploads, submissions } = fakeClient()
    const adapter = createFalAdapter(client)

    const { providerJobId } = await adapter.submit(FASHN, tryOnInput)

    expect(providerJobId).toBe('req-123')
    expect(uploads).toHaveLength(2)
    expect(submissions[0].endpoint).toBe('fal-ai/fashn/tryon/v1.6')
    expect(submissions[0].input).toEqual({
      model_image: 'https://fal.media/upload-0.webp',
      garment_image: 'https://fal.media/upload-1.webp',
      category: 'tops',
      mode: 'quality',
      garment_photo_type: 'flat-lay',
    })
  })

  it('换发型任务只上传人物图，不做多余的服装图往返', async () => {
    const { client, uploads, submissions } = fakeClient()
    const adapter = createFalAdapter(client)

    await adapter.submit(HAIR_MODEL, hairInput)

    expect(uploads).toHaveLength(1)
    expect(submissions[0].input).toEqual({
      image_url: 'https://fal.media/upload-0.webp',
      target_hairstyle: 'bob_cut',
      hair_color: 'balayage',
    })
  })

  it('上传的 blob 带有正确的 MIME 类型与字节数', async () => {
    const { client, uploads } = fakeClient()

    await createFalAdapter(client).submit(HAIR_MODEL, hairInput)

    expect(uploads[0].type).toBe('image/webp')
    expect(uploads[0].size).toBe(tryOnInput.person.bytes.length)
  })

  it('credentials 只在首次调用时配置一次', async () => {
    const { client, configs } = fakeClient()
    const adapter = createFalAdapter(client)

    await adapter.submit(HAIR_MODEL, hairInput)
    await adapter.submit(HAIR_MODEL, hairInput)

    expect(configs).toHaveLength(1)
    expect(configs[0].credentials).toBe('test-fal-key-not-used')
  })

  it('未登记的端点在上传图片之前就失败', async () => {
    const { client, uploads } = fakeClient()
    const adapter = createFalAdapter(client)

    await expect(
      adapter.submit({ ...HAIR_MODEL, endpoint: 'fal-ai/unknown' }, hairInput),
    ).rejects.toThrow(/未在参数映射表中登记/)

    // 关键：不该为一个注定失败的任务先花掉一次上传
    expect(uploads).toHaveLength(0)
  })
})

describe('FalAdapter.poll', () => {
  async function pollOnce(statusSequence: string[], resultError?: Error) {
    const { client } = fakeClient({ statusSequence, resultError })
    return createFalAdapter(client).poll(HAIR_MODEL, 'req-123')
  }

  it('IN_QUEUE 视为未完成', async () => {
    expect(await pollOnce(['IN_QUEUE'])).toEqual({ state: 'pending' })
  })

  it('IN_PROGRESS 视为未完成', async () => {
    expect(await pollOnce(['IN_PROGRESS'])).toEqual({ state: 'pending' })
  })

  it('COMPLETED 时取回结果并原样带出', async () => {
    const result = await pollOnce(['COMPLETED'])

    expect(result.state).toBe('succeeded')
    expect(result).toMatchObject({ raw: { images: [{ url: 'https://fal.media/out.webp' }] } })
  })

  it('结果请求返回 HTTP 错误时给出带状态码的失败', async () => {
    const error = new ApiError({ message: 'upstream exploded', status: 500 })
    const result = await pollOnce(['COMPLETED'], error)

    expect(result).toMatchObject({ state: 'failed', code: 'http_500' })
    expect(result.state === 'failed' && result.message).toContain('upstream exploded')
  })

  it('用户超时被单独标记，以免编排层盲目重试', async () => {
    // 注意 isUserTimeout 的判定是 `status === 504 && timeoutType === 'user'`，
    // 两个条件缺一不可 —— fal 从响应头读 timeoutType，普通 504 不算用户超时。
    const error = new ApiError({ message: 'timed out', status: 504, timeoutType: 'user' })
    const result = await pollOnce(['COMPLETED'], error)

    expect(result).toMatchObject({ state: 'failed', code: 'user_timeout' })
  })

  it('没有 timeoutType 的 504 按普通上游错误处理，仍可重试', async () => {
    const error = new ApiError({ message: 'gateway timeout', status: 504 })
    const result = await pollOnce(['COMPLETED'], error)

    expect(result).toMatchObject({ state: 'failed', code: 'http_504' })
  })

  it('状态查询本身失败时也不会抛出，而是报告失败', async () => {
    const client = fakeClient().client
    client.queue.status = async () => {
      throw new ApiError({ message: 'unauthorized', status: 401 })
    }

    // 编排层按"读状态"循环调用这里，抛异常会打断整个 worker，
    // 因此失败必须表现为返回值。
    const result = await createFalAdapter(client).poll(HAIR_MODEL, 'req-123')

    expect(result).toMatchObject({ state: 'failed', code: 'http_401' })
  })

  it('非 ApiError 的意外异常同样被收敛成失败结果', async () => {
    const client = fakeClient().client
    client.queue.status = async () => {
      throw new TypeError('socket hang up')
    }

    const result = await createFalAdapter(client).poll(HAIR_MODEL, 'req-123')

    expect(result).toMatchObject({ state: 'failed', code: 'status_request_failed' })
  })
})

describe('FalAdapter.normalizeResult', () => {
  it('从上游返回体中取出图片 URL', () => {
    const adapter = createFalAdapter(fakeClient().client)

    expect(adapter.normalizeResult(FASHN, { images: [{ url: 'https://x/y.webp' }] })).toEqual({
      imageUrl: 'https://x/y.webp',
    })
  })

  it('多张图时取第一张', () => {
    const adapter = createFalAdapter(fakeClient().client)

    const out = adapter.normalizeResult(FASHN, {
      images: [{ url: 'https://x/1.webp' }, { url: 'https://x/2.webp' }],
    })

    expect(out.imageUrl).toBe('https://x/1.webp')
  })
})

describe('extractImageUrl 对畸形返回体的处理', () => {
  it.each([
    ['null', null],
    ['字符串', 'nope'],
    ['缺少 images', { foo: 1 }],
    ['images 为空数组', { images: [] }],
    ['images 元素缺少 url', { images: [{ width: 100 }] }],
    ['url 为空串', { images: [{ url: '' }] }],
  ])('%s 时抛出可读错误', (_label, payload) => {
    expect(() => extractImageUrl(payload)).toThrow()
  })
})

describe('describeErrorBody', () => {
  it('把 fal 的校验错误整理成 loc: msg 的形式', () => {
    // 这是 fal 校验失败时的真实形态
    const body = {
      detail: [
        { loc: ['body', 'garment_image'], msg: 'field required', type: 'value_error.missing' },
      ],
    }

    expect(describeErrorBody(body)).toBe(' — body.garment_image: field required')
  })

  it('多条校验错误用分号连接', () => {
    const body = {
      detail: [
        { loc: ['body', 'a'], msg: '错一' },
        { loc: ['body', 'b'], msg: '错二' },
      ],
    }

    expect(describeErrorBody(body)).toBe(' — body.a: 错一; body.b: 错二')
  })

  it('detail 是字符串时直接用', () => {
    expect(describeErrorBody({ detail: '图片太小' })).toBe(' — 图片太小')
  })

  it('非预期形状退回截断的 JSON', () => {
    expect(describeErrorBody({ error: 'something' })).toContain('something')
  })

  it('没有 body 时返回空串', () => {
    expect(describeErrorBody(undefined)).toBe('')
    expect(describeErrorBody(null)).toBe('')
  })

  it('超长内容被截断，避免把日志撑爆', () => {
    const body = { detail: 'x'.repeat(2000) }

    expect(describeErrorBody(body).length).toBeLessThan(420)
  })

  it('循环引用不会抛错', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    expect(() => describeErrorBody(cyclic)).not.toThrow()
  })
})
