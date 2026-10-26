import type { UIMessage } from 'ai'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'

import { db } from '@/lib/db'
import { conversations, messages, type MessagePart } from '@/lib/db/schema'
import { stripAnnotationLines } from './annotations'

/**
 * 对话的落库与读回。
 *
 * 这张表当初就设计好了（`messages.id` 与 `UIMessage.id` 对齐、注释写明"由前端生成，
 * 这样刷新页面后 message id 保持一致，工具调用结果能正确回填"），只是**一直没有人写它**。
 * 代价很具体：用户传完全身照与服装图、识别、确认、生成，然后刷新页面 ——
 * `assetId` 全丢，模型手里一个 id 都没有，只能说"请重新上传一张"。
 * `listRecentPhotos` 这个工具存在的全部理由就是绕开这个洞打补丁。
 */

/**
 * 一轮对话最多带多少条消息。
 *
 * 一个数字管两头，因为它们**必须一致**：读回来的一屏消息会被客户端在下一轮
 * 原样发上去，所以"能读回多少"不能超过"能接收多少"，否则用户刷新一次之后
 * 就再也发不出消息了（400，而且看起来毫无原因）。
 */
export const MAX_CONVERSATION_MESSAGES = 60

/** 标题截断长度。够在列表里认出是哪次对话即可 */
export const TITLE_MAX = 40

/** 历史列表一次列几条 */
export const CONVERSATION_LIST_LIMIT = 50

/**
 * conversationId 的形状校验。
 *
 * 它由客户端生成（见 `ensureConversation` 的说明），会被塞进 URL 与请求体，
 * 并成为一行记录的主键。不校验的话客户端能往库里塞任意长度的字符串 ——
 * 不是注入（语句是参数化的），但同样是"不该由用户决定的东西"。
 *
 * 页面与聊天路由共用这一处判断：各写一遍就会有两套宽松程度，
 * 而差异只会在某一侧被绕过的那个晚上才暴露出来。
 */
const CONVERSATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID_RE.test(value)
}

/** 从 parts 里取出纯文本，忽略工具调用等结构化部分 */
function textOf(message: UIMessage): string {
  const chunks: string[] = []
  for (const part of message.parts) {
    if (part.type === 'text') chunks.push(part.text)
  }
  return chunks.join('\n')
}

/**
 * 从消息里推导一个标题：取第一条**用户**消息的正文。
 *
 * 必须剥掉标注行。不剥的话，用工作台提交时标题会变成
 * "按工作台选好的素材批量试穿，请原样使用下面这些 id：" ——
 * 列表里每一条都长这样，历史记录就等于没有。
 *
 * 推导不出正文（用户只传了图没打字）时返回 null，由界面回退成时间。
 * 不为此多花一次模型调用：标题只是用来认路的。
 */
export function deriveTitle(uiMessages: readonly UIMessage[], max = TITLE_MAX): string | null {
  for (const message of uiMessages) {
    if (message.role !== 'user') continue

    const text = stripAnnotationLines(textOf(message))
    if (!text) continue

    return text.length > max ? `${text.slice(0, max)}…` : text
  }

  return null
}

/**
 * 确认这个 conversationId 可用，不可用返回 false。
 *
 * 客户端生成 id（服务端生成的话，客户端得靠读流式响应的 header 才知道 id，
 * 那就得再包一层 fetch；而客户端生成只需这一次 upsert）。安全性靠这里：
 * 一个已存在的 id，只有它的归属会话能继续用。
 *
 * 返回 false 时调用方**必须拒绝整个请求**，而不是"新开一个"。后者会让
 * 攻击者用一个猜到的 id 把自己的消息写进别人的对话历史里 —— 读不到，
 * 但能把垃圾留进去。
 */
export async function ensureConversation(
  sessionId: string,
  conversationId: string,
): Promise<boolean> {
  const [existing] = await db
    .select({ sessionId: conversations.sessionId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1)

  if (existing) return existing.sessionId === sessionId

  // onConflictDoNothing 兜住并发：两个请求同时带着同一个新 id 进来时，
  // 只有一条能插进去，另一条也不会抛。
  await db
    .insert(conversations)
    .values({ id: conversationId, sessionId })
    .onConflictDoNothing()

  return true
}

/**
 * 落库一轮对话。
 *
 * 幂等：客户端每轮都会把整段历史一起发上来，所以同一批消息会被反复写。
 * `onConflictDoUpdate` 而不是 insert —— 主键冲突会让整次对话的落库失败，
 * 而那时用户看到的是一次成功的对话，只是刷新后又没了。
 */
export async function saveConversation(
  conversationId: string,
  uiMessages: readonly UIMessage[],
): Promise<void> {
  if (uiMessages.length === 0) return

  await db
    .insert(messages)
    .values(
      uiMessages.map((message) => ({
        id: message.id,
        conversationId,
        role: message.role,
        parts: message.parts as MessagePart[],
      })),
    )
    .onConflictDoUpdate({
      target: messages.id,
      // 只换内容。`seq` 不在 set 里，冲突行保留它原本的顺序号 ——
      // 否则每次继续对话都会把历史消息的次序重排一遍
      set: { parts: sql`excluded.parts` },
    })

  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId))

  const title = deriveTitle(uiMessages)

  if (title) {
    // 只在还没有标题时写。否则每次继续对话都会把标题换成最新那句话，
    // 列表里所有条目都显示最后说的内容 —— 历史记录就再也认不出哪次是哪次
    await db
      .update(conversations)
      .set({ title })
      .where(and(eq(conversations.id, conversationId), isNull(conversations.title)))
  }
}

export interface StoredConversation {
  id: string
  title: string | null
  messages: UIMessage[]
}

/**
 * 读回一次对话。不属于本会话时返回 null（与"不存在"返回同一个值）。
 *
 * 两种情况刻意合并：分开的话，拿一串 id 去试就能问出"哪些 id 是存在的"。
 */
export async function loadConversation(
  sessionId: string,
  conversationId: string,
  { limit = MAX_CONVERSATION_MESSAGES }: { limit?: number } = {},
): Promise<StoredConversation | null> {
  const [conversation] = await db
    .select({ id: conversations.id, title: conversations.title })
    .from(conversations)
    // 归属校验：少了它，拿一串 id 就能读到别人的整段对话 ——
    // 包括他传过的照片 id、看过的建议、生成过的结果
    .where(and(eq(conversations.id, conversationId), eq(conversations.sessionId, sessionId)))
    .limit(1)

  if (!conversation) return null

  /*
   * 取**最新的** limit 条，再翻回时间顺序。
   *
   * 正着取前 limit 条是错的：长对话里用户刷新后看到的是最开头那段，
   * 而他要接着说的是最后一句话的下一句。
   *
   * 排序用 seq 而不是 created_at，理由见 schema 里那一列上的注释。
   */
  const rows = await db
    .select({ id: messages.id, role: messages.role, parts: messages.parts })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.seq))
    .limit(limit)

  return {
    id: conversation.id,
    title: conversation.title,
    /*
     * 这个 cast 是一个**信任边界**：parts 当初就是从 UIMessage 存进去的，
     * 经 jsonb 往返后按原样交给界面。库里要是被塞进形状不对的 parts，
     * 这里不会拦，界面上会是一块渲染不出来的卡片。第一版接受这个前提。
     */
    messages: rows
      .reverse()
      .map((row) => ({ id: row.id, role: row.role, parts: row.parts }) as UIMessage),
  }
}

export interface ConversationSummary {
  id: string
  title: string | null
  updatedAt: string
}

/**
 * 列表里那一行显示什么。
 *
 * 没有标题时回退到时间：只传图没打字的那次对话没有正文可当标题
 * （见 `deriveTitle`），而一行空白条目等于"历史里有一条你永远认不出来的东西"。
 *
 * 放在这里而不是组件里，是为了能直接测 —— 组件文件会连带拉起数据库与 cookie，
 * 而这个函数只有一个分支，却决定用户认不认得出哪次是哪次。
 */
export function conversationLabel(title: string | null, updatedAt: string): string {
  if (title) return title

  const at = new Date(updatedAt)
  // 时间戳解析不出来时也必须给出一句话。返回空字符串的话，
  // 列表里就会出现一行看不见、点得动、也不知道是什么的东西
  if (Number.isNaN(at.getTime())) return '（未命名对话）'

  const pad = (value: number) => String(value).padStart(2, '0')

  // 不用 toLocaleString：它跟着运行环境变，而这一行要在服务端定死
  return `（未命名）${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** 本会话的对话列表，最近更新的在前 */
export async function listConversations(
  sessionId: string,
  { limit = CONVERSATION_LIST_LIMIT }: { limit?: number } = {},
): Promise<ConversationSummary[]> {
  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(eq(conversations.sessionId, sessionId))
    .orderBy(desc(conversations.updatedAt))
    .limit(limit)

  return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }))
}
