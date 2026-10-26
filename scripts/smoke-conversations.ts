/**
 * 对话落库的真实行为校验（临时脚本）。
 *
 * 单测验的是生成的 SQL，而下面这几件事**只在真实 Postgres 上才成立**：
 *   1. `onConflictDoUpdate` 真的不产生重复行（客户端每轮都重发整段历史）
 *   2. 冲突行真的保住原来的 `seq`（顺序不被打乱）
 *   3. 标题真的只写一次，之后不被覆盖
 *   4. `limit` 取的是最新 N 条，且读回来是时间正序
 *   5. 换个会话真的读不到
 *
 * 会往库里写一行临时 session（messages 的外键链要求它有），跑完删掉。
 */
import '@/lib/load-env'

import type { UIMessage } from 'ai'
import { eq } from 'drizzle-orm'

import { db } from '@/lib/db'
import { messages, sessions } from '@/lib/db/schema'
import { ensureConversation, loadConversation, saveConversation } from '@/lib/chat/conversations'

const SESSION = `check-conv-${Date.now()}`
const OTHER_SESSION = `check-conv-other-${Date.now()}`
const CONVERSATION = crypto.randomUUID()

function msg(id: string, role: 'user' | 'assistant', text: string): UIMessage {
  return { id, role, parts: [{ type: 'text', text }] }
}

const turn1 = [msg('u1', 'user', '帮我试试这件'), msg('a1', 'assistant', '第一件的效果在这里')]
// 第二轮：客户端会把**整段历史**再发一遍，外加两条新的
const turn2 = [...turn1, msg('u2', 'user', '换成蓝色的'), msg('a2', 'assistant', '换好了')]

let failures = 0

function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

async function main() {
  await db.insert(sessions).values({ id: SESSION }).onConflictDoNothing()
  await db.insert(sessions).values({ id: OTHER_SESSION }).onConflictDoNothing()

  console.log('A. 归属')
  check('自己的 id 放行', (await ensureConversation(SESSION, CONVERSATION)) === true)
  check('别人的 id 被拒', (await ensureConversation(OTHER_SESSION, CONVERSATION)) === false)
  check('换个会话读不到', (await loadConversation(OTHER_SESSION, CONVERSATION)) === null)

  console.log('B. 幂等（客户端每轮重发整段历史）')
  await saveConversation(CONVERSATION, turn1)
  await saveConversation(CONVERSATION, turn2)

  const rows = await db
    .select({ id: messages.id, seq: messages.seq })
    .from(messages)
    .where(eq(messages.conversationId, CONVERSATION))

  check('行数正好 4（重发没有产生重复）', rows.length === 4, `实际 ${rows.length}`)
  check('没有重复 id', new Set(rows.map((r) => r.id)).size === rows.length)
  check('seq 各不相同', new Set(rows.map((r) => r.seq)).size === rows.length)

  console.log('C. 顺序')
  const loaded = await loadConversation(SESSION, CONVERSATION, { limit: 50 })
  check(
    '读回来是时间正序',
    loaded?.messages.map((m) => m.id).join(',') === 'u1,a1,u2,a2',
    loaded?.messages.map((m) => m.id).join(','),
  )

  const tail = await loadConversation(SESSION, CONVERSATION, { limit: 2 })
  check(
    'limit 取的是最新两条（不是最旧两条）',
    tail?.messages.map((m) => m.id).join(',') === 'u2,a2',
    tail?.messages.map((m) => m.id).join(','),
  )

  console.log('D. 标题')
  check('标题取首条用户消息', loaded?.title === '帮我试试这件', String(loaded?.title))

  await saveConversation(CONVERSATION, [...turn2, msg('u3', 'user', '再来一件')])
  const after = await loadConversation(SESSION, CONVERSATION, { limit: 50 })
  check('继续对话不会把标题换成最新那句话', after?.title === '帮我试试这件', String(after?.title))

  console.log('E. 冲突行保住原来的 seq')
  const afterRows = await db
    .select({ id: messages.id, seq: messages.seq })
    .from(messages)
    .where(eq(messages.conversationId, CONVERSATION))
  const seqOf = new Map(afterRows.map((r) => [r.id, r.seq]))
  const before = new Map(rows.map((r) => [r.id, r.seq]))
  check(
    'u1/a1/u2/a2 的 seq 一个都没变',
    [...before].every(([id, seq]) => seqOf.get(id) === seq),
  )

  console.log('F. 收尾')
  await db.delete(sessions).where(eq(sessions.id, SESSION))
  await db.delete(sessions).where(eq(sessions.id, OTHER_SESSION))
  const leftover = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, CONVERSATION))
  check('级联删干净了', leftover.length === 0, `还剩 ${leftover.length} 行`)

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
