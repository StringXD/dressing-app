import type { UIMessage } from 'ai'

import { buildAgentStream } from '@/lib/agent/chat'
import {
  MAX_CONVERSATION_MESSAGES,
  ensureConversation,
  isConversationId,
  saveConversation,
} from '@/lib/chat/conversations'
import { requireSessionId } from '@/lib/session'

/**
 * 对话入口。
 *
 * 这是**唯一**会花钱的用户入口：模型在对话里调用 enqueueTryOn / enqueueHairChange，
 * 经用户审批后才真正入队。刻意不做 REST 入队路由 —— 多一条路径就多一处
 * 要同步配额、归属与参数校验的地方，而这条路径上的疏漏直接等于白花的钱。
 *
 * 路由本身保持极薄：所有装配都在 `buildAgentStream()` 里，那边是可单测的。
 */

export async function POST(request: Request) {
  // 会创建 cookie，因此必须在 Route Handler 里调用
  const sessionId = await requireSessionId()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }

  const { messages, conversationId } = (body ?? {}) as {
    messages?: unknown
    conversationId?: unknown
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: 'messages 必须是非空数组' }, { status: 400 })
  }

  if (messages.length > MAX_CONVERSATION_MESSAGES) {
    return Response.json(
      {
        error: `一次最多发送 ${MAX_CONVERSATION_MESSAGES} 条消息，收到 ${messages.length} 条`,
      },
      { status: 400 },
    )
  }

  /*
   * conversationId 是**必填**的。
   *
   * 做成可选、缺了就"不落库"看起来更兼容，但那条路径的失败是静默的：
   * 客户端忘了带，一切照常工作，直到用户刷新 —— 然后整段对话消失。
   * 那正是这个功能要修的东西。宁可在这里 400。
   */
  if (!isConversationId(conversationId)) {
    return Response.json({ error: 'conversationId 必须是 UUID' }, { status: 400 })
  }

  // 已存在的 id 只有它的归属会话能继续用。拒绝时**不能**顺手新开一个 ——
  // 那等于允许猜到的 id 也留下痕迹
  if (!(await ensureConversation(sessionId, conversationId))) {
    return Response.json({ error: '这个对话不属于当前会话' }, { status: 403 })
  }

  const result = await buildAgentStream({
    sessionId,
    conversationId,
    messages: messages as UIMessage[],
  })

  return result.toUIMessageStreamResponse({
    /*
     * 传 originalMessages 才会进入"持久化模式"，响应消息才会拿到 id。
     * 不传的话助手那条消息没有 id，而 `messages.id` 是主键 —— 落库直接失败。
     */
    originalMessages: messages as UIMessage[],

    onEnd: async ({ messages: finalMessages }) => {
      /*
       * 落库失败**不能**让对话失败。
       *
       * 流已经发完了，钱该花的已经花了。在这里抛出去，用户看到的是一次成功的
       * 对话变成报错，而唯一真实的后果只是"刷新后看不到这次记录" ——
       * 让它安静地记一条日志，比让用户以为生成失败要好。
       * （与 `labelAsAiGenerated` 同样的取舍。）
       *
       * 中止（用户中途刷新/关页面）时也存：助手那条可能是半截的，
       * 但用户自己发的那条和已经执行过的工具调用都在里面，丢掉更糟。
       */
      try {
        await saveConversation(conversationId, finalMessages)
      } catch (error) {
        console.error('[chat] 对话落库失败，本次记录刷新后不可见', error)
      }
    },
  })
}
