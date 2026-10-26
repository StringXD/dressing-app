import { listRecentResults } from '@/lib/generation/results'
import { getSessionId } from '@/lib/session'

/**
 * 最近生成结果。界面上的「最近结果」区靠它渲染对比滑块。
 *
 * 与 `/api/queue` 的分工：那边回答"我关心的这几个任务现在怎么样了"（要客户端先给 id），
 * 这边回答"我最近生成过什么"（不需要 id）。刷新页面后客户端手里一个 id 都没有，
 * 第一种查询就失效了，而结果区恰恰最需要在刷新后仍然工作。
 */

/** 一次最多列多少条。结果区是"最近几条"的预览，不是分页列表。 */
const LIMIT = 12

export async function GET() {
  // 只读，不创建会话：GET 不该有副作用
  const sessionId = await getSessionId()

  if (!sessionId) {
    return Response.json(
      { results: [] },
      { headers: { 'cache-control': 'no-store' } },
    )
  }

  const results = await listRecentResults(sessionId, {
    limit: LIMIT,
    /*
     * 失败也要列。
     *
     * `output_download_failed` 这类失败**上游已经生成并计费**，只是我们没下回来。
     * 只显示成功，用户会以为那次没花钱，进而放心重试 —— 而重试是要再付一次的。
     * 这与 `progress-notice.tsx` 里那套"已计费 / 未计费 / 不确定"的三态提示
     * 是同一个原则：涉及钱的时候，宁可说得保守。
     */
    statuses: ['succeeded', 'failed'],
  })

  return Response.json(
    { results },
    // 结果随时可能新增（生成完成），缓存会让新图迟迟不出现
    { headers: { 'cache-control': 'no-store' } },
  )
}
