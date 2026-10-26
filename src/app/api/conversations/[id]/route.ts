import { loadConversation } from '@/lib/chat/conversations'
import { getSessionId } from '@/lib/session'

/**
 * 读回一次对话的全部消息。
 *
 * **不属于本会话与不存在返回同一个 404**（`loadConversation` 本身就把两种情况
 * 合并成了 null）。分开的话，拿一串 id 去试就能问出"哪些 id 是真实存在的" ——
 * 那是关于别人有没有在用这个应用的信息。
 */
export async function GET(_request: Request, ctx: RouteContext<'/api/conversations/[id]'>) {
  const sessionId = await getSessionId()

  if (!sessionId) {
    return Response.json({ error: '找不到这次对话' }, { status: 404 })
  }

  const { id } = await ctx.params
  const conversation = await loadConversation(sessionId, id)

  if (!conversation) {
    return Response.json({ error: '找不到这次对话' }, { status: 404 })
  }

  return Response.json(conversation, { headers: { 'cache-control': 'no-store' } })
}
