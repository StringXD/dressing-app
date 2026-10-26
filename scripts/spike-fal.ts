/**
 * 阶段 0：fal 三端点的真实调用验证。
 *
 * ── 它验证什么 ────────────────────────────────────────────────
 *
 * 最重要的是**参数映射是否成立**：`paramMap.ts` 里的字段名与枚举取值
 * 是从 fal 官方文档写的，从未经过真实调用。三个端点的字段名各不相同
 * （`model_image` vs `person_image_url`、`garment_photo_type` 用下划线），
 * 写错要到真正调用时才暴露。所以这个脚本刻意走**真实的
 * `createFalAdapter()`**，而不是另写一套调用逻辑 —— 否则验的是复刻品，不是产线代码。
 *
 * 其次是拿到真实产物供人工评判效果，以及记录各端点的实际耗时与出图规格。
 *
 * ── 关于图片 ──────────────────────────────────────────────────
 *
 * 计划要求"用你自己的真实全身照"。**效果评判确实只能用真照片** ——
 * 合成剪影能验证接口契约，但看不出换装好不好看。
 *
 * 因此支持两条路：
 *   · 传真实照片路径：`tsx scripts/spike-fal.ts <人物照> [服装图]`
 *   · 不传则用 sharp 现场合成剪影，仅用于验证接口契约（会在报告里标注）
 *
 * 用法：
 *   ./node_modules/.bin/tsx scripts/spike-fal.ts                       # 合成图，验契约
 *   ./node_modules/.bin/tsx scripts/spike-fal.ts my-photo.jpg shirt.jpg # 真照片，看效果
 *   ./node_modules/.bin/tsx scripts/spike-fal.ts --only=fashn           # 只跑指定端点
 *
 * `--only` 接受 fashn / apps-v2 / hair 的任意组合（逗号分隔）。重试某个端点时
 * 用它，避免为已经成功过的端点再付一次钱。
 */

import '@/lib/load-env'

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import sharp from 'sharp'

import { getModelById, MODELS } from '@/lib/providers/models.config'
import { createFalAdapter } from '@/lib/providers/fal/adapter'
import type { ImageInput, ModelSpec, TaskInput } from '@/lib/providers/types'

const OUTPUT_DIR = 'spike-output'

/** 单次轮询间隔与总时限 */
const POLL_INTERVAL_MS = 1_500
const POLL_DEADLINE_MS = 300_000

/** 端点的短名，用于 --only 筛选 */
type EndpointKey = 'fashn' | 'apps-v2' | 'hair'

const ALL_ENDPOINTS: readonly EndpointKey[] = ['fashn', 'apps-v2', 'hair']

function log(message: string): void {
  console.log(message)
}

function ok(label: string, detail = ''): void {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
}

function bad(label: string, detail = ''): void {
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `  ${detail}` : ''}`)
}

// ── 合成测试图 ─────────────────────────────────────────────────
//
// 用 SVG 现场画，不引入任何外部素材 —— 既没有版权问题，
// 也让脚本在没有真实照片时可以独立跑通。

/** 极简人体剪影：头、躯干、手臂、腿。够用来验证接口契约。 */
async function makeSyntheticPerson(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1152">
    <rect width="768" height="1152" fill="#e8e4dd"/>
    <circle cx="384" cy="200" r="85" fill="#c8a888"/>
    <rect x="360" y="275" width="48" height="45" fill="#c8a888"/>
    <path d="M300 320 L468 320 L490 620 L278 620 Z" fill="#5a7a9a"/>
    <rect x="255" y="325" width="45" height="270" rx="22" fill="#c8a888"/>
    <rect x="468" y="325" width="45" height="270" rx="22" fill="#c8a888"/>
    <path d="M290 620 L375 620 L370 1000 L295 1000 Z" fill="#3a4a5a"/>
    <path d="M395 620 L480 620 L475 1000 L400 1000 Z" fill="#3a4a5a"/>
  </svg>`

  return sharp(Buffer.from(svg)).webp({ quality: 92 }).toBuffer()
}

/** 平铺的 T 恤轮廓 —— 对应 garment_photo_type: flat-lay */
async function makeSyntheticGarment(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768">
    <rect width="768" height="768" fill="#ffffff"/>
    <path d="M240 220 L300 175 L365 205 L405 205 L470 175 L530 220 L565 330 L492 362
             L492 610 L278 610 L278 362 L205 330 Z"
          fill="#d94f4f" stroke="#b03a3a" stroke-width="6" stroke-linejoin="round"/>
    <path d="M300 175 Q385 245 470 175" fill="none" stroke="#b03a3a" stroke-width="6"/>
  </svg>`

  return sharp(Buffer.from(svg)).webp({ quality: 92 }).toBuffer()
}

async function readImageFile(path: string): Promise<ImageInput> {
  const bytes = await readFile(path)

  // 归一化到 webp 并限制长边，和上传链路保持一致
  const normalized = await sharp(bytes)
    .rotate()
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 92 })
    .toBuffer()

  return { bytes: normalized, mime: 'image/webp', filename: path.split(/[\\/]/).pop() ?? 'input.webp' }
}

// ── 单个端点的验证 ─────────────────────────────────────────────

interface SpikeResult {
  model: ModelSpec
  ok: boolean
  elapsedMs: number
  detail: string
  outputBytes?: number
  outputFormat?: string
  outputWidth?: number
  outputHeight?: number
  savedPath?: string
}

const adapter = createFalAdapter()

async function pollToSettled(
  model: ModelSpec,
  providerJobId: string,
): Promise<
  | { state: 'succeeded'; imageUrl: string }
  | { state: 'failed'; code: string; message: string }
> {
  const deadline = Date.now() + POLL_DEADLINE_MS

  for (;;) {
    const result = await adapter.poll(model, providerJobId)

    if (result.state === 'succeeded') {
      const { imageUrl } = adapter.normalizeResult(model, result.raw)
      return { state: 'succeeded', imageUrl }
    }

    if (result.state === 'failed') {
      return { state: 'failed', code: result.code, message: result.message }
    }

    if (Date.now() >= deadline) {
      return {
        state: 'failed',
        code: 'poll_timeout',
        message: `等待超过 ${POLL_DEADLINE_MS / 1000} 秒`,
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

async function runEndpoint(
  model: ModelSpec,
  input: TaskInput,
  outputBase: string,
): Promise<SpikeResult> {
  const startedAt = Date.now()

  log(`\n▸ ${model.label}  \x1b[2m(${model.endpoint})\x1b[0m`)

  // submit 会走真实的 paramMap + storage.upload。参数名不对会在这里炸出来。
  let providerJobId: string
  try {
    const submitted = await adapter.submit(model, input)
    providerJobId = submitted.providerJobId
    ok('提交成功（参数映射被上游接受）', `job=${providerJobId.slice(0, 18)}…`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    bad('提交失败', message)

    // 提交失败最常见的两种原因是参数名写错与图片被拒，
    // 把上游原始信息带出来，否则只能靠猜
    const body = (error as { body?: unknown }).body
    if (body) log(`     \x1b[2m上游返回：${JSON.stringify(body).slice(0, 400)}\x1b[0m`)

    return { model, ok: false, elapsedMs: Date.now() - startedAt, detail: `提交失败：${message}` }
  }

  const settled = await pollToSettled(model, providerJobId)
  const elapsedMs = Date.now() - startedAt

  if (settled.state === 'failed') {
    bad('生成失败', `${settled.code} ${settled.message}`)
    return { model, ok: false, elapsedMs, detail: `${settled.code}: ${settled.message}` }
  }

  ok('生成完成', `${(elapsedMs / 1000).toFixed(1)}s`)

  // 下载产物并存到 spike-output/ 供人工评判
  let bytes: Buffer
  try {
    const response = await fetch(settled.imageUrl)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    bad('下载产物失败', message)
    return { model, ok: false, elapsedMs, detail: `下载失败：${message}` }
  }

  const meta = await sharp(bytes).metadata()

  // 扩展名必须由真实字节决定，不能事先约定：实测三个端点返回的格式各不相同
  // （v1.6 是 PNG，apps-v2 与换发型是 JPEG），写死会让产物"看着像 webp、
  // 其实是 png"，人工评判时打不开或误判格式。sharp 对 JPEG 报 'jpeg'，
  // 统一成项目惯用的 'jpg'（见 process.ts 的 MIME_EXT）。
  const ext = meta.format === 'jpeg' ? 'jpg' : (meta.format ?? 'bin')
  const savedPath = join(OUTPUT_DIR, `${outputBase}.${ext}`)
  await writeFile(savedPath, bytes)

  ok(
    '产物已保存',
    `${savedPath}  ${(bytes.length / 1024).toFixed(0)}KB  ${meta.format} ${meta.width}×${meta.height}`,
  )

  return {
    model,
    ok: true,
    elapsedMs,
    detail: `${meta.width}×${meta.height} ${meta.format}`,
    outputBytes: bytes.length,
    outputFormat: meta.format,
    outputWidth: meta.width,
    outputHeight: meta.height,
    savedPath,
  }
}

// ── 主流程 ─────────────────────────────────────────────────────

/**
 * 解析命令行参数。
 *
 * 分开处理 `--only=` 与位置参数，避免把 flag 当成照片路径 ——
 * 那样会得到一个"文件不存在"的误导性错误。
 */
function parseArgs(argv: string[]): { personPath?: string; garmentPath?: string; only: EndpointKey[] } {
  const positional: string[] = []
  let only: EndpointKey[] = [...ALL_ENDPOINTS]

  for (const arg of argv) {
    if (arg.startsWith('--only=')) {
      const requested = arg
        .slice('--only='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      const invalid = requested.filter((k) => !ALL_ENDPOINTS.includes(k as EndpointKey))
      if (invalid.length > 0) {
        console.error(
          `\x1b[31m--only 里有未知端点：${invalid.join(', ')}\x1b[0m\n` +
            `可选：${ALL_ENDPOINTS.join(', ')}`,
        )
        process.exit(1)
      }

      only = requested as EndpointKey[]
    } else if (arg.startsWith('--')) {
      console.error(`\x1b[31m未知参数：${arg}\x1b[0m`)
      process.exit(1)
    } else {
      positional.push(arg)
    }
  }

  return { personPath: positional[0], garmentPath: positional[1], only }
}

async function main(): Promise<void> {
  const { personPath, garmentPath, only } = parseArgs(process.argv.slice(2))
  const usingRealPhotos = Boolean(personPath)

  log('\n\x1b[1m阶段 0：fal 端点验证\x1b[0m')

  if (only.length !== ALL_ENDPOINTS.length) {
    log(`\x1b[2m只跑：${only.join(', ')}\x1b[0m`)
  }

  if (!process.env.FAL_KEY) {
    bad('未配置 FAL_KEY', '请在 .env 中填入，见 .env.example')
    process.exit(1)
  }

  log(
    usingRealPhotos
      ? `\n图片：真实照片（${personPath}${garmentPath ? ` / ${garmentPath}` : ''}）`
      : '\n图片：\x1b[33m合成剪影\x1b[0m —— 足以验证接口契约，但\x1b[1m看不出换装效果\x1b[0m。' +
          '\n      要评判效果请传入真实全身照：tsx scripts/spike-fal.ts <人物照> [服装图]',
  )

  // 条件直接用 personPath 而不是 usingRealPhotos：
  // `Boolean(x)` 不会让 TS 收窄 x 的类型，这里必须靠直接判断拿到 string
  const person: ImageInput = personPath
    ? await readImageFile(personPath)
    : { bytes: await makeSyntheticPerson(), mime: 'image/webp', filename: 'synthetic-person.webp' }

  const garment: ImageInput = garmentPath
    ? await readImageFile(garmentPath)
    : { bytes: await makeSyntheticGarment(), mime: 'image/webp', filename: 'synthetic-garment.webp' }

  await mkdir(OUTPUT_DIR, { recursive: true })

  const results: SpikeResult[] = []

  // 1. 换装（旗舰档）—— 唯一显式支持平铺图的端点
  const fashn = getModelById('fal/fashn-tryon-1.6')
  if (fashn && only.includes('fashn')) {
    results.push(
      await runEndpoint(
        fashn,
        {
          kind: 'tryon',
          person,
          garment,
          category: 'tops',
          mode: 'quality',
          garmentPhotoType: 'flat-lay',
        },
        'tryon-fashn',
      ),
    )
  }

  // 2. 换装（经济档）—— 参数名与旗舰档完全不同，专门用来验证映射层的多态
  const appTryOn = getModelById('fal/apps-v2-tryon')
  if (appTryOn && only.includes('apps-v2')) {
    results.push(
      await runEndpoint(
        appTryOn,
        {
          kind: 'tryon',
          person,
          garment,
          category: 'tops',
          mode: 'quality',
          garmentPhotoType: 'flat-lay',
        },
        'tryon-apps-v2',
      ),
    )
  }

  // 3. 换发型 —— 用枚举而非 prompt
  const hair = getModelById('fal/hair-change')
  if (hair && only.includes('hair')) {
    results.push(
      await runEndpoint(
        hair,
        { kind: 'hair', person, hairstyle: 'long_hair', color: 'light_brown' },
        'hair-change',
      ),
    )
  }

  // ── 汇总 ───────────────────────────────────────────────────
  log('\n\x1b[1m结果汇总\x1b[0m')
  log('  端点                          结果   耗时      产物              单次成本')

  let totalCost = 0

  for (const result of results) {
    const status = result.ok ? '\x1b[32m成功\x1b[0m' : '\x1b[31m失败\x1b[0m'
    const cost = result.ok ? `$${result.model.costUsdPerRun.toFixed(3)}` : '—'
    if (result.ok) totalCost += result.model.costUsdPerRun

    log(
      `  ${result.model.label.padEnd(24, ' ').slice(0, 24)}  ${status}  ` +
        `${`${(result.elapsedMs / 1000).toFixed(1)}s`.padEnd(9, ' ')} ` +
        `${(result.detail || '').padEnd(18, ' ').slice(0, 18)} ${cost}`,
    )
  }

  log(`\n  本次实际花费：\x1b[1m$${totalCost.toFixed(3)}\x1b[0m`)

  const failed = results.filter((r) => !r.ok)
  const succeeded = results.filter((r) => r.ok)

  if (failed.length === 0) {
    log('\n\x1b[32m\x1b[1m三个端点的参数映射全部被上游接受\x1b[0m')
  } else {
    log(`\n\x1b[31m\x1b[1m${failed.length} 个端点失败\x1b[0m —— 见上方各端点的错误详情`)
  }

  if (usingRealPhotos && succeeded.length > 0) {
    log(`\n产物在 \x1b[1m${OUTPUT_DIR}/\x1b[0m，请人工确认换装效果是否可用。`)
  } else if (succeeded.length > 0) {
    log(
      `\n产物在 \x1b[1m${OUTPUT_DIR}/\x1b[0m。\x1b[33m注意：用的是合成剪影，无法据此评判效果。\x1b[0m`,
    )
    log('要评判效果，请用真实全身照重跑一次。')
  }

  // 供后续接线参考：注册表里还有哪些模型
  log(`\n注册表共 ${MODELS.length} 个模型，全部为可商用授权。`)

  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('\n\x1b[31m执行失败：\x1b[0m', error)
  process.exit(1)
})
