import { getQueueItems, getQueueStats } from '@/lib/queue/stats'
import { getSessionId } from '@/lib/session'

/** 一次最多查询的任务数。批量网格一屏也放不下这么多。 */
const MAX_IDS = 50

/** 无会话时的空统计 —— 比返回全局数字更正确，也避免泄露别人的用量 */
const EMPTY_STATS = { queued: 0, processing: 0, succeeded: 0, failed: 0, canceled: 0 }

/**
 * 队列状态查询。前端据此轮询队列面板与批量网格的进度。
 *
 * `GET /api/queue?ids=a,b,c` → 这些任务各自的队位与状态。
 * 不传 ids 则只返回统计。
 *
 * 有意**不**暴露 pg-boss 的内部计数：那是运维视角，跟用户无关，
 * 而且会让这个端点依赖队列客户端。用户面板要的是业务统计，纯 SQL 就够，
 * 轮询它也就不必在 Web 进程里启一个队列客户端。
 */
export async function GET(request: Request) {
  const rawIds = new URL(request.url).searchParams.get('ids')
  const ids = rawIds
    ? rawIds
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : []

  if (ids.length > MAX_IDS) {
    return Response.json(
      { error: `一次最多查询 ${MAX_IDS} 个任务，收到 ${ids.length} 个` },
      { status: 400 },
    )
  }

  // 只读，不创建会话：GET 不该有副作用
  const sessionId = await getSessionId()

  if (!sessionId) {
    return Response.json(
      { stats: EMPTY_STATS, items: [] },
      { headers: { 'cache-control': 'no-store' } },
    )
  }

  const [stats, items] = await Promise.all([
    getQueueStats(sessionId),
    ids.length > 0 ? getQueueItems(sessionId, ids) : Promise.resolve([]),
  ])

  return Response.json(
    { stats, items },
    // 队列状态每秒都在变，任何缓存都会让进度条看起来卡住
    { headers: { 'cache-control': 'no-store' } },
  )
}
