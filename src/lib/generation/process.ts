import { setTimeout as sleep } from 'node:timers/promises'

import { and, eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { assets, garments, generations, type Generation } from '@/lib/db/schema'
import {
  getModelById,
  getProvider,
  type ImageInput,
  type ModelSpec,
  type ProviderAdapter,
  type SettledPollResult,
  type TaskInput,
} from '@/lib/providers'
import { storage, buildStorageKey } from '@/lib/storage'

import { parseGenerationParams } from './params'

/**
 * 轮询节奏。fal 的试穿通常几十秒出结果，2 秒一次足够灵敏又不至于打爆上游。
 */
const POLL_INTERVAL_MS = 2_000

/**
 * 轮询总时限。必须**明显小于**队列的 expireInSeconds（900 秒）：
 * 否则 pg-boss 会认为任务卡死并重跑，而我们这边还在正常轮询 —— 结果是同一张图付两次钱。
 */
const POLL_DEADLINE_MS = 600_000

/** 输入有问题、重试也不会变好的错误。立刻判死，不浪费重试次数。 */
export class TerminalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'TerminalError'
  }
}

/** 网络抖动、上游 5xx 之类 —— 重试有意义。 */
export class RetryableError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RetryableError'
  }
}

/**
 * 上游失败码里哪些值得重试。
 *
 * 默认**不重试**：重试内容风控这类确定性拒绝只会多花一次钱，
 * 而且用户等更久。宁可少重试，也不要盲目重试。
 */
function isRetryable(code: string): boolean {
  return (
    code === 'status_request_failed' ||
    code === 'result_request_failed' ||
    code === 'output_download_failed' ||
    code === 'poll_timeout' ||
    /^http_5\d\d$/.test(code) ||
    /^http_429$/.test(code)
  )
}

/**
 * 原子认领任务。
 *
 * **只认领 `queued`，这是防重复扣费的唯一真正屏障**，别改成"非终态即可"：
 * 那样一条正在 `processing` 的记录会被重复投递的消息再认领一次，
 * 于是同一个任务向上游提交两次 —— 用户被收两次钱。
 *
 * 那重试怎么还能工作？因为可重试失败时我们会显式把状态退回 `queued`
 * （见 processGeneration 的 catch 分支），pg-boss 重新投递时自然能认领。
 * 崩溃留下的孤儿 `processing` 则由启动对账统一退回 `queued`。
 *
 * 返回 null 表示任务不存在、已被别人认领、或已是终态 —— 都该安静跳过。
 */
export async function claimGeneration(generationId: string): Promise<Generation | null> {
  const [claimed] = await db
    .update(generations)
    .set({ status: 'processing', updatedAt: new Date() })
    .where(and(eq(generations.id, generationId), eq(generations.status, 'queued')))
    .returning()

  return claimed ?? null
}

/** 从存储层按 asset 取出原始字节，组装成 provider 要的 ImageInput */
async function loadImageInput(assetId: string): Promise<ImageInput> {
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1)

  if (!asset) {
    throw new TerminalError('asset_missing', `assets 表中找不到 ${assetId}`)
  }

  const object = await storage.get(asset.storageKey)
  if (!object) {
    throw new TerminalError('asset_unreadable', `存储中读不到 ${asset.storageKey}`)
  }

  return {
    bytes: object.body,
    mime: asset.mime,
    // 部分上游按文件名推断格式；存储 key 的 basename 正好可用
    filename: asset.storageKey.split('/').pop() ?? `${assetId}.webp`,
  }
}

/**
 * 取服装图。
 *
 * ⚠️ 必须先经 garments 表换算：`generations.garment_id` 指向的是 **garments 行**，
 * 而图片字节挂在它引用的 **asset** 上。把 garmentId 直接当 assetId 用会得到
 * `asset_missing` —— 这个坑已经被验收测试踩出来过一次。
 */
async function loadGarmentImage(garmentId: string): Promise<ImageInput> {
  const [garment] = await db
    .select({ assetId: garments.assetId })
    .from(garments)
    .where(eq(garments.id, garmentId))
    .limit(1)

  if (!garment) {
    throw new TerminalError('garment_missing', `garments 表中找不到 ${garmentId}`)
  }

  return loadImageInput(garment.assetId)
}

/**
 * 把 DB 里的一行还原成 provider 层的统一输入。
 *
 * switch 而非 if：这样 TS 能同时收窄 taskKind 与 params 的类型，
 * 避免在这一层写类型断言（断言一旦写错，要花掉真实调用的钱才发现）。
 */
function buildTaskInput(generation: Generation, person: ImageInput, garment: ImageInput | null): TaskInput {
  switch (generation.taskKind) {
    case 'tryon': {
      if (!garment) {
        throw new TerminalError('garment_missing', '换装任务缺少服装图引用')
      }
      const params = parseGenerationParams('tryon', generation.params)
      return {
        kind: 'tryon',
        person,
        garment,
        category: params.category,
        mode: params.mode,
        garmentPhotoType: params.garmentPhotoType,
      }
    }

    case 'hair': {
      const params = parseGenerationParams('hair', generation.params)
      return {
        kind: 'hair',
        person,
        hairstyle: params.hairstyle,
        color: params.color,
      }
    }
  }
}

/** 轮询到出结果为止。返回最后一次的终态结果。 */
async function pollUntilSettled(
  adapter: ProviderAdapter,
  model: ModelSpec,
  providerJobId: string,
  options: { intervalMs: number; deadlineMs: number; signal?: AbortSignal },
): Promise<SettledPollResult> {
  const deadline = Date.now() + options.deadlineMs

  for (;;) {
    if (options.signal?.aborted) {
      return { state: 'failed', code: 'aborted', message: '任务被取消' }
    }

    const result = await adapter.poll(model, providerJobId)
    if (result.state !== 'pending') return result

    if (Date.now() >= deadline) {
      return {
        state: 'failed',
        code: 'poll_timeout',
        message: `等待上游超过 ${Math.round(options.deadlineMs / 1000)} 秒仍未出图`,
      }
    }

    await sleep(options.intervalMs)
  }
}

const MIME_EXT: Record<string, 'webp' | 'png' | 'jpg' | 'jpeg'> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
}

/**
 * 把上游的生成图转存到我们自己的存储。
 *
 * 必须转存，不能只存 fal 的 URL：那些 URL 有有效期，
 * 且用户查历史时不该依赖第三方可用性。这也让阶段 8 的水印与合规标识有落点。
 *
 * fetch 由调用方注入（默认全局 fetch）。注入而非直接使用全局，
 * 是为了让整条 worker 链路能在不打网络的前提下被测到。
 */
async function storeResult(
  generation: Generation,
  imageUrl: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  let response: Response
  try {
    response = await fetchImpl(imageUrl)
  } catch (error) {
    throw new RetryableError(
      'output_download_failed',
      `下载生成图时网络错误：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!response.ok) {
    throw new RetryableError('output_download_failed', `下载生成图失败：HTTP ${response.status}`)
  }

  const mime = response.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/webp'
  const ext = MIME_EXT[mime]

  if (!ext) {
    throw new TerminalError('unexpected_output_type', `上游返回了非预期图片类型：${mime}`)
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  const assetId = crypto.randomUUID()
  const key = buildStorageKey('generated', generation.sessionId, assetId, ext)

  const stored = await storage.put(key, bytes, { mime })

  await db.insert(assets).values({
    id: assetId,
    sessionId: generation.sessionId,
    kind: 'generated',
    storageKey: key,
    mime,
    bytes: stored.bytes,
  })

  return assetId
}

export type ProcessOutcome =
  | { status: 'succeeded'; outputAssetId: string }
  | { status: 'failed'; code: string; message: string }
  | { status: 'skipped'; reason: string }

export interface ProcessOptions {
  /** 测试注入用；默认按 providerId 取真实 adapter */
  adapter?: ProviderAdapter
  /** 测试注入用；默认全局 fetch */
  fetchImpl?: typeof fetch
  pollIntervalMs?: number
  pollDeadlineMs?: number
  signal?: AbortSignal
}

/**
 * 处理一个生成任务。**不抛异常**——所有结果都以返回值表达，
 * 唯一的例外是可重试失败：那种情况会抛出，好让 pg-boss 记录一次失败的尝试并安排重试。
 */
export async function processGeneration(
  generationId: string,
  options: ProcessOptions = {},
): Promise<ProcessOutcome> {
  const claimed = await claimGeneration(generationId)

  if (!claimed) {
    // 已终态、或任务不存在。重复投递时走到这里属于正常情况，不是错误。
    return { status: 'skipped', reason: '任务已是终态或不存在' }
  }

  const startedAt = Date.now()

  try {
    const model = getModelById(claimed.modelId)
    if (!model) {
      throw new TerminalError('model_not_found', `模型注册表中没有 ${claimed.modelId}`)
    }

    const adapter = options.adapter ?? getProvider(model.providerId)

    // 已经有上游任务就绝不再提交一次。
    //
    // 每次重试都是一次新的 processGeneration 调用，而 claimGeneration 只认领
    // queued —— 可重试失败会把状态退回 queued（见下方 catch 分支），于是重投时
    // 又会走到这里。若无条件 submit，重试就等于重新买一张图：
    //   · poll_timeout：上一轮上游其实还在跑，两轮都可能出图、都计费
    //   · output_download_failed：图已生成并计费，只因我们没下载成功就被丢弃重买
    // 复用 providerJobId 只是接着查同一个上游任务，不再产生费用。
    // 已实测：同一场景下无条件 submit 会提交 2 次，复用后只提交 1 次。
    let providerJobId = claimed.providerJobId

    if (!providerJobId) {
      const person = await loadImageInput(claimed.personAssetId)
      const garment = claimed.garmentId ? await loadGarmentImage(claimed.garmentId) : null
      const input = buildTaskInput(claimed, person, garment)

      providerJobId = (await adapter.submit(model, input)).providerJobId

      // 立刻落库：进程如果在这里挂掉，重启后能靠它接着查上游结果，而不是重新提交
      await db
        .update(generations)
        .set({ providerJobId, updatedAt: new Date() })
        .where(eq(generations.id, generationId))
    }

    const polled = await pollUntilSettled(adapter, model, providerJobId, {
      intervalMs: options.pollIntervalMs ?? POLL_INTERVAL_MS,
      deadlineMs: options.pollDeadlineMs ?? POLL_DEADLINE_MS,
      signal: options.signal,
    })

    if (polled.state === 'failed') {
      // 上游明确拒绝（内容风控、参数非法）没有重试价值；网络问题才值得再试
      if (isRetryable(polled.code)) {
        throw new RetryableError(polled.code, polled.message)
      }
      throw new TerminalError(polled.code, polled.message)
    }

    const { imageUrl } = adapter.normalizeResult(model, polled.raw)
    const outputAssetId = await storeResult(claimed, imageUrl, options.fetchImpl ?? fetch)

    await db
      .update(generations)
      .set({
        status: 'succeeded',
        outputAssetId,
        // 只记成功调用的成本：失败的上游通常不计费，记进去会让看板虚高
        costUsd: model.costUsdPerRun,
        latencyMs: Date.now() - startedAt,
        errorCode: null,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(generations.id, generationId))

    return { status: 'succeeded', outputAssetId }
  } catch (error) {
    const code =
      error instanceof TerminalError || error instanceof RetryableError
        ? error.code
        : 'internal_error'
    const message = error instanceof Error ? error.message : String(error)

    if (error instanceof RetryableError) {
      // 退回 queued 再抛出：pg-boss 重新投递时 claimGeneration 才能认领。
      // 重试预算由队列的 retryLimit 界定，这里不自己数次数。
      await db
        .update(generations)
        .set({
          status: 'queued',
          errorCode: code,
          errorMessage: message,
          updatedAt: new Date(),
        })
        .where(eq(generations.id, generationId))

      throw error
    }

    await db
      .update(generations)
      .set({
        status: 'failed',
        errorCode: code,
        errorMessage: message,
        latencyMs: Date.now() - startedAt,
        updatedAt: new Date(),
      })
      .where(eq(generations.id, generationId))

    return { status: 'failed', code, message }
  }
}
