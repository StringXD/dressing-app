import Link from 'next/link'

import { conversationLabel, listConversations } from '@/lib/chat/conversations'
import { getSessionId } from '@/lib/session'

/**
 * 历史记录。
 *
 * **服务端渲染，不是客户端拉取。** 它要的就是"这次页面加载时有哪些对话"这个快照：
 * 没有加载态、没有首屏闪烁、禁用 JS 也点得动。
 *
 * 快照的代价要说清楚：刚新建的这次对话要等下一次服务端渲染才会出现在列表里。
 * 这由 `ChatPanel` 在每轮对话结束后调一次 `router.refresh()` 来触发 ——
 * 少了那一步，用户发完第一句话会发现历史里根本没有它。
 */

export async function ConversationList({ currentId }: { currentId: string }) {
  // 只读，不创建会话 —— 打开历史不该给访客发一个 cookie
  const sessionId = await getSessionId()

  if (!sessionId) return null

  const conversations = await listConversations(sessionId)

  // 一次对话都没有时不占地方：新用户看到的应该是一个干净的开始
  if (conversations.length === 0) return null

  return (
    <section className="mb-4 rounded-2xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-medium text-neutral-500">历史记录</h2>
        <Link
          href="/chat"
          className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
        >
          新建对话
        </Link>
      </div>

      <ul className="space-y-0.5">
        {conversations.map((conversation) => {
          const active = conversation.id === currentId

          return (
            <li key={conversation.id}>
              <Link
                href={`/chat?c=${conversation.id}`}
                // 当前这条仍然给链接（点它就是重载当前对话），但用 aria-current
                // 标出来 —— 只靠背景色的话，色弱用户和读屏软件都判断不出"我在哪"
                aria-current={active ? 'page' : undefined}
                className={`block truncate rounded-lg px-2 py-1 text-sm ${
                  active
                    ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                    : 'text-neutral-600 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-800/60'
                }`}
              >
                {conversationLabel(conversation.title, conversation.updatedAt)}
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
