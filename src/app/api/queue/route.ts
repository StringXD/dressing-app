import { getQueueItems, getQueueStats, listActiveGenerations } from '@/lib/queue/stats'
import { getSessionId } from '@/lib/session'

/** 一次最多查询的任务数。批量网格一屏也放不下这么多。 */
const MAX_IDS = 50

/** 无会话时的空统计 —— 比返回全局数字更正确，也避免泄露别人的用量 */
const EMPTY_STATS = { queued: 0, processing: 0, succeeded: 0, failed: 0, canceled: 0 }

/**
 * 队列状态查询。前端据此轮询队列面板与批量网格的进度。
 *
 * `GET /api/queue?ids=a,b,c` → 这些任务各自的队位与状态（进度面板用）。
 * 两种形态都额外返回 `active`：本会话所有**未结束**的任务。
 *
 * `active` 是为了回答"刷新之后还剩什么"：进度面板跟踪的任务列表存在前端内存里，
 * 刷新即失，正在跑的换装就再没有界面显示它了。这个答案只能由服务端给，
 * 而且它与 `ids` 那份回答的是不同问题，所以并不互相替代。
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
      { stats: EMPTY_STATS, items: [], active: [] },
      { headers: { 'cache-control': 'no-store' } },
    )
  }

  const [stats, items, active] = await Promise.all([
    getQueueStats(sessionId),
    ids.length > 0 ? getQueueItems(sessionId, ids) : Promise.resolve([]),
    // 无论给不给 ids 都返回，因为这两份数据回答的是**不同问题**：
    // ids 那份是"我关心的这几个怎么样了"（能带出终态失败的原因），
    // active 这份是"我这个会话现在还有什么在跑"。
    // 只在没有 ids 时才给的话，会出现这样一个窗口：刷新后看到两个任务在跑，
    // 一旦新入队一个，ids 变非空，那两个老任务就又消失了。
    listActiveGenerations(sessionId),
  ])

  return Response.json(
    { stats, items, active },
    // 队列状态每秒都在变，任何缓存都会让进度条看起来卡住
    { headers: { 'cache-control': 'no-store' } },
  )
}
