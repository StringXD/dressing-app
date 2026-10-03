/**
 * 队列与 worker 的端到端验证（阶段 4 的完成标准）。
 *
 * 验证四件事：
 *   1. 一次性入队 5 个任务，worker 按入队顺序处理（FIFO）
 *   2. 并发不超过 FAL_CONCURRENCY
 *   3. 队位查询正确
 *   4. worker 被强杀后重启，未完成的任务能恢复
 *
 * 与单测互补：单测验的是函数行为，这里验的是**真实进程 + 真实队列 + 真实 Postgres**。
 * 唯一被替换的是"调上游"那一段（换成假 provider），因为没拿到 fal Key 时
 * 上面这些性质根本无从观测。改动的范围被严格限制在 adapter 与 fetch 两个注入点，
 * 队列装配、认领、对账跑的都是产线代码。
 *
 * 用法：
 *   1. docker compose up -d
 *   2. ./node_modules/.bin/tsx scripts/smoke-queue.ts
 */

import './lib/load-env'

import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

import { inArray, notInArray } from 'drizzle-orm'
import sharp from 'sharp'

import { db } from '@/lib/db'
import {
  assets,
  garments,
  generations,
  sessions,
  TERMINAL_STATUSES,
} from '@/lib/db/schema'
import { getModelById } from '@/lib/providers'
import { GENERATION_QUEUE, getBoss, stopBoss } from '@/lib/queue/boss'
import { enqueueGeneration } from '@/lib/queue/enqueue'
import { getBossQueueHealth, getGenerationQueueInfo, getQueueStats } from '@/lib/queue/stats'
import { buildStorageKey, storage } from '@/lib/storage'

import { EVENT_MARKER } from './lib/stub-provider'

/** 验收用的并发上限。显式写死并传给子进程，避免 .env 里的值让断言飘忽。 */
const CONCURRENCY = 2
const WORKER_SCRIPT = 'scripts/worker-with-stub.ts'

function ok(label: string, detail = ''): void {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
}

function fail(label: string, detail = ''): never {
  console.error(`  \x1b[31m✗\x1b[0m ${label}${detail ? `  ${detail}` : ''}`)
  process.exit(1)
}

function assert(condition: unknown, label: string, detail = ''): asserts condition {
  if (condition) ok(label, detail)
  else fail(label, detail)
}

// ── 子进程管理 ────────────────────────────────────────────────

const running = new Set<ChildProcess>()

interface WorkerHandle {
  child: ChildProcess
  /** 子进程通过 stdout 回传的结构化事件，按到达顺序 */
  events: Array<Record<string, unknown>>
}

function spawnWorker(env: Record<string, string>): WorkerHandle {
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER_SCRIPT], {
    env: { ...process.env, FAL_CONCURRENCY: String(CONCURRENCY), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  running.add(child)
  const events: Array<Record<string, unknown>> = []
  let buffer = ''

  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (line.startsWith(EVENT_MARKER)) {
        events.push(JSON.parse(line.slice(EVENT_MARKER.length)))
      } else if (line.trim()) {
        console.log(`    \x1b[2m[worker] ${line}\x1b[0m`)
      }
    }
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`    \x1b[2m[worker:err] ${chunk.toString('utf8').trimEnd()}\x1b[0m\n`)
  })

  child.on('exit', () => running.delete(child))

  return { child, events }
}

/** 强杀 —— 刻意不用 SIGTERM，要模拟的是进程崩溃而非优雅退出 */
async function killHard(child: ChildProcess): Promise<void> {
  child.kill('SIGKILL')
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

/** 等某个条件成立。超时即判失败，避免测试挂死。 */
async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(150)
  }

  fail(`等待超时：${label}`)
}

// ── 测试数据 ─────────────────────────────────────────────────

async function statusesOf(ids: string[]): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: generations.id, status: generations.status })
    .from(generations)
    .where(inArray(generations.id, ids))

  return new Map(rows.map((r) => [r.id, r.status]))
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled'])

function allTerminal(map: Map<string, string>): boolean {
  return [...map.values()].every((s) => TERMINAL.has(s))
}

async function createSession(): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(sessions).values({ id })
  return id
}

/** 造一张真实落盘的图片资产 —— loadImageInput 会真的去存储层读它 */
async function createAsset(sessionId: string, rgb: { r: number; g: number; b: number }): Promise<string> {
  const assetId = crypto.randomUUID()
  const bytes = await sharp({
    create: { width: 64, height: 96, channels: 3, background: rgb },
  })
    .webp()
    .toBuffer()

  const key = buildStorageKey('uploads', sessionId, assetId, 'webp')
  const stored = await storage.put(key, bytes, { mime: 'image/webp' })

  await db.insert(assets).values({
    id: assetId,
    sessionId,
    kind: 'upload',
    storageKey: key,
    mime: 'image/webp',
    bytes: stored.bytes,
  })

  return assetId
}

/**
 * 服装记录。
 *
 * ⚠️ `generations.garment_id` 指向的是 **garments 表**而不是 assets 表 ——
 * 服装是"带来源信息的资产"，两者不是一回事。直接把 assetId 当 garmentId 传
 * 会被外键拦下（实测如此）。
 *
 * sourceKind 用 screenshot：这类服装没有来源 URL，正好绕开
 * uniqueIndex(session_id, source_url) 对 NULL 的处理。
 */
async function createGarment(sessionId: string, assetId: string): Promise<string> {
  const id = crypto.randomUUID()

  await db.insert(garments).values({
    id,
    sessionId,
    sourceKind: 'screenshot',
    assetId,
    title: '验收测试用服装',
    photoType: 'flat-lay',
  })

  return id
}

async function main(): Promise<void> {
  console.log('\n\x1b[1m队列与 worker 端到端验证\x1b[0m')
  console.log(`  并发上限 CONCURRENCY = ${CONCURRENCY}\n`)

  // ── 清场 ────────────────────────────────────────────────────
  // 让脚本可重复运行。不清的话上次残留会污染本轮：
  //  · 队列里的旧消息（pg-boss 存在 Postgres，默认保留一天）会被本轮 worker 领走，
  //    混进事件序列，让"处理顺序"断言变成噪声
  //  · 上次留下的非终态任务会被本轮的对账捞回来处理，同样混进事件序列
  console.log('0. 清场')
  const boss = await getBoss()

  await db
    .update(generations)
    .set({ status: 'canceled', errorCode: 'test_cleanup', updatedAt: new Date() })
    .where(notInArray(generations.status, [...TERMINAL_STATUSES]))
  ok('上次残留的非终态任务已置为 canceled')

  await boss.deleteAllJobs(GENERATION_QUEUE)
  ok('队列消息已清空')

  const model = getModelById('fal/apps-v2-tryon')
  if (!model) fail('模型注册表缺少 fal/apps-v2-tryon')

  const sessionId = await createSession()
  const personAssetId = await createAsset(sessionId, { r: 200, g: 160, b: 140 })
  const garmentAssetId = await createAsset(sessionId, { r: 40, g: 80, b: 160 })
  const garmentId = await createGarment(sessionId, garmentAssetId)

  const enqueue = () =>
    enqueueGeneration({
      sessionId,
      taskKind: 'tryon',
      model,
      personAssetId,
      garmentId,
      params: { category: 'tops', mode: 'quality', garmentPhotoType: 'flat-lay' },
    })

  // ── A. FIFO 与并发上限 ──────────────────────────────────────
  console.log('A. 一次性入队 5 个任务')

  const batch: string[] = []
  for (let i = 0; i < 5; i += 1) {
    const created = await enqueue()
    batch.push(created.id)
  }
  assert(batch.length === 5, '已入队 5 个任务')

  // 队位：第 5 个任务前面应当有 4 个，第 1 个前面 0 个
  const first = await getGenerationQueueInfo(batch[0])
  const last = await getGenerationQueueInfo(batch[4])
  assert(first?.position === 0, '队首任务前面 0 个', `position=${first?.position}`)
  assert(last?.position === 4, '队尾任务前面 4 个', `position=${last?.position}`)
  assert(last?.active === true, '排队中的任务标记为 active')

  const statsBefore = await getQueueStats()
  assert(statsBefore.queued === 5, '业务统计：queued = 5', `queued=${statsBefore.queued}`)

  const bossHealth = await getBossQueueHealth()
  assert(
    bossHealth !== null && bossHealth.total >= 5,
    'pg-boss 视角也能看到这些任务（两种统计交叉验证）',
    `total=${bossHealth?.total} ready=${bossHealth?.ready}`,
  )

  console.log('\nA. 启动 worker 并等待全部完成')
  const workerA = spawnWorker({ STUB_LATENCY_MS: '700' })

  await waitFor('5 个任务全部进入终态', async () => allTerminal(await statusesOf(batch)))

  const finalA = await statusesOf(batch)
  const succeededA = batch.filter((id) => finalA.get(id) === 'succeeded')
  assert(succeededA.length === 5, '5 个任务全部成功', `succeeded=${succeededA.length}`)

  // 顺序：从子进程回传的事件里读出真实的开始顺序
  const startOrder = workerA.events
    .filter((e) => e.event === 'start')
    .map((e) => e.generationId as string)
  assert(
    JSON.stringify(startOrder) === JSON.stringify(batch),
    '处理顺序与入队顺序完全一致（FIFO）',
    `实际 ${startOrder.length} 个事件`,
  )

  const maxInFlight = Math.max(
    ...workerA.events.filter((e) => e.event === 'start').map((e) => e.inFlight as number),
  )
  assert(
    maxInFlight <= CONCURRENCY,
    `同时进行的任务数未超过上限 ${CONCURRENCY}`,
    `峰值 ${maxInFlight}`,
  )
  assert(maxInFlight > 1, '确实出现过并发（否则并发上限没被真正验证）', `峰值 ${maxInFlight}`)

  // 产物：每个任务都该有自己的输出资产，且文件真实落盘
  const outputRows = await db
    .select({ id: generations.id, outputAssetId: generations.outputAssetId })
    .from(generations)
    .where(inArray(generations.id, batch))

  const outputIds = outputRows.map((r) => r.outputAssetId)
  assert(outputIds.every((id) => id !== null), '每个任务都写入了输出资产')
  assert(new Set(outputIds).size === 5, '5 个输出资产互不相同', `distinct=${new Set(outputIds).size}`)

  const [oneOutput] = await db
    .select()
    .from(assets)
    .where(inArray(assets.id, outputIds as string[]))
    .limit(1)

  assert(oneOutput?.kind === 'generated', '输出资产标记为 generated', `kind=${oneOutput?.kind}`)
  const storedOutput = await storage.get(oneOutput.storageKey)
  assert(storedOutput !== null, '输出图真实存在于存储中', `${storedOutput?.body.length} 字节`)
  assert(
    (await sharp(storedOutput.body).metadata()).format === 'png',
    '输出图可被解码（内容有效而不仅是字节）',
  )

  await killHard(workerA.child)
  ok('已停止 A 阶段 worker')

  // ── B. 崩溃恢复 ─────────────────────────────────────────────
  console.log('\nB. 崩溃恢复：强杀正在工作的 worker')

  const crashBatch: string[] = []
  for (let i = 0; i < 3; i += 1) {
    const created = await enqueue()
    crashBatch.push(created.id)
  }

  // 延迟调到 8 秒，保证有任务卡在"进行中"时被强杀
  const workerB = spawnWorker({ STUB_LATENCY_MS: '8000' })

  await waitFor('至少一个任务进入 processing', async () => {
    const map = await statusesOf(crashBatch)
    return [...map.values()].some((s) => s === 'processing')
  })

  const beforeKill = await statusesOf(crashBatch)
  const processingBefore = [...beforeKill.values()].filter((s) => s === 'processing').length
  assert(processingBefore > 0, '强杀前确有任务在进行中', `processing=${processingBefore}`)
  assert(!allTerminal(beforeKill), '强杀前任务尚未完成')

  await killHard(workerB.child)

  const afterKill = await statusesOf(crashBatch)
  assert(
    [...afterKill.values()].every((s) => !TERMINAL.has(s)),
    '强杀后任务卡在非终态（模拟真实崩溃留下的残局）',
    [...afterKill.values()].join(','),
  )

  // 重启：对账应当把孤儿 processing 退回 queued 并重新投递
  const workerC = spawnWorker({ STUB_LATENCY_MS: '400' })
  await waitFor('重启后残局任务全部恢复并完成', async () => allTerminal(await statusesOf(crashBatch)))

  const finalC = await statusesOf(crashBatch)
  const recovered = crashBatch.filter((id) => finalC.get(id) === 'succeeded')
  assert(recovered.length === 3, '3 个中断的任务全部恢复成功', `succeeded=${recovered.length}`)

  const reconcileLog = workerC.events.length > 0
  assert(reconcileLog, '重启后的 worker 正常开始工作')

  await killHard(workerC.child)

  // ── C. 可重试失败后不得重复提交上游任务 ──────────────────────
  console.log('\nC. 重试恢复：让第一次下载产物失败')

  // 只入队 1 个任务，这样整个 worker 生命周期里的 submit 事件都归它，
  // 不必给桩 provider 的 submit 事件再加 generationId（适配器本就不知道它）。
  const retryId = (await enqueue()).id

  // 让第一次下载产物失败。这是最尖锐的可重试失败：上游那张图已经生成、已经计费，
  // 只是我们没拿到。若重试时重新 submit，就等于把付过钱的图丢掉再买一张。
  const workerD = spawnWorker({ STUB_LATENCY_MS: '300', STUB_FAIL_DOWNLOADS: '1' })

  await waitFor('任务重试后进入终态', async () => allTerminal(await statusesOf([retryId])))

  const finalD = await statusesOf([retryId])
  assert(finalD.get(retryId) === 'succeeded', '重试后最终成功', `status=${finalD.get(retryId)}`)

  // 这条断言是防止本场景变成空测：若根本没发生重试，下面的 submit 计数就毫无意义。
  // 它同时也能反过来证明 pg-boss 的 retryLimit 是否真的生效。
  const startCount = workerD.events.filter((e) => e.event === 'start').length
  assert(startCount === 2, '确实重新进入了一次处理（说明重试真的发生了）', `start=${startCount}`)

  const submitCount = workerD.events.filter((e) => e.event === 'submit').length
  assert(
    submitCount === 1,
    '重试时复用了原上游任务，没有再次提交（否则同一张图会被计费两次）',
    `submit=${submitCount}`,
  )

  await killHard(workerD.child)

  // ── D. 收尾 ─────────────────────────────────────────────────
  console.log('\nD. 收尾')
  const statsAfter = await getQueueStats()
  assert(statsAfter.queued === 0, '队列已排空', `queued=${statsAfter.queued}`)
  assert(statsAfter.processing === 0, '无任务卡在进行中', `processing=${statsAfter.processing}`)

  console.log('\n\x1b[32m\x1b[1m全部通过\x1b[0m\n')
}

/** 无论如何都别把子进程和 pg-boss 连接池留在后台 */
async function cleanup(): Promise<void> {
  for (const child of running) {
    child.kill('SIGKILL')
  }
  await stopBoss().catch(() => {})
}

main()
  .then(cleanup)
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('\n\x1b[31m执行失败：\x1b[0m', error)
    await cleanup()
    process.exit(1)
  })
