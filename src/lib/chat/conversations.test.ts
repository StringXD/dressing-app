import type { UIMessage } from 'ai'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  conversationLabel,
  deriveTitle,
  ensureConversation,
  listConversations,
  loadConversation,
  saveConversation,
} from './conversations'

/**
 * 守的是这个模块的三件事，每一件写错都**不会报错**：
 *
 * 1. **归属**：读回别人的对话，等于泄露他传过的照片 id、看过的建议、生成过的结果。
 * 2. **幂等**：客户端每轮都把整段历史重发一遍，所以同一批消息会被反复写。
 *    用普通 insert 的话主键冲突会让落库整段失败 —— 而用户看到的是一次成功的对话，
 *    只是刷新后又没了，最难归因的那种。
 * 3. **顺序**：`seq` 不在冲突更新里，重存才不会打乱历史次序。
 *
 * 这个项目里的单测一律不连数据库（见 `tests/api-results.test.ts` 的说明），
 * 所以这三件事都只能验生成的 SQL。**真实行为另用真库核对过**，见下面注释。
 */

const whereCalls: { condition: unknown; projectionKeys: string[] }[] = []
const orderByCalls: unknown[] = []
const limitCalls: unknown[] = []
const insertCalls: { values: unknown; conflict: unknown }[] = []

interface UpdateCall {
  set: Record<string, unknown>
  condition: unknown | null
}

// 必须声明在 vi.mock 之前：工厂在模块求值时就会被调用，
// 声明在后面会撞上暂时性死区（而报错信息指向的是一行无关的 import）
const updateCallsHolder = { calls: [] as UpdateCall[] }

const { dbHolder } = vi.hoisted(() => ({
  dbHolder: { selects: [] as unknown[][], index: 0 },
}))

vi.mock('@/lib/db', () => {
  let projectionKeys: string[] = []
  let updateSet: Record<string, unknown> = {}

  function takeSelect(): unknown[] {
    const rows = dbHolder.selects[dbHolder.index] ?? []
    dbHolder.index += 1
    return rows
  }

  const selectChain: Record<string, unknown> = {}
  selectChain.from = () => selectChain
  selectChain.where = (condition: unknown) => {
    // 按**投影**记身份，不按表名或列名去找：同一个函数里会有两三条查询
    // 命中同一种写法，用 `sql.includes('...')` 找会挑中另一条，
    // 断言就在测一个无关的东西 —— 上一轮真这么写出过一个空测
    whereCalls.push({ condition, projectionKeys: [...projectionKeys] })
    return selectChain
  }
  selectChain.orderBy = (node: unknown) => {
    orderByCalls.push(node)
    return selectChain
  }
  selectChain.limit = (n: unknown) => {
    limitCalls.push(n)
    return Promise.resolve(takeSelect())
  }
  selectChain.then = (onF: (r: unknown[]) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(takeSelect()).then(onF, onR)

  const insertChain: Record<string, unknown> = {}
  let pendingValues: unknown = null
  insertChain.values = (values: unknown) => {
    pendingValues = values
    return insertChain
  }
  insertChain.onConflictDoUpdate = (conflict: unknown) => {
    insertCalls.push({ values: pendingValues, conflict })
    return Promise.resolve()
  }
  insertChain.onConflictDoNothing = () => {
    insertCalls.push({ values: pendingValues, conflict: { doNothing: true } })
    return Promise.resolve()
  }

  const updateChain: Record<string, unknown> = {}
  updateChain.set = (set: Record<string, unknown>) => {
    updateSet = set
    return updateChain
  }
  updateChain.where = (condition: unknown) => {
    updateCallsHolder.calls.push({ set: updateSet, condition })
    return Promise.resolve()
  }

  const select = (projection?: Record<string, unknown>) => {
    projectionKeys = projection ? Object.keys(projection) : []
    return selectChain
  }

  return {
    db: { select, insert: () => insertChain, update: () => updateChain },
  }
})

const SESSION = 'sess-mine'
const OTHER_SESSION = 'sess-other'
const CONVERSATION = '11111111-1111-1111-1111-111111111111'

function userMessage(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

function assistantMessage(id: string, text: string): UIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] }
}

beforeEach(() => {
  whereCalls.length = 0
  orderByCalls.length = 0
  limitCalls.length = 0
  insertCalls.length = 0
  updateCallsHolder.calls.length = 0
  dbHolder.selects = []
  // 这个计数器必须重置。漏掉它，从第二个测试起每条查询都读到空数组，
  // 于是"不属于本会话"之类的分支全被静默跳过 —— 症状是几个看似无关的断言一起红
  dbHolder.index = 0
})

function renderedWhere(projectionKey: string) {
  const found = whereCalls.find((call) => call.projectionKeys.includes(projectionKey))
  if (!found) throw new Error(`没有选了 ${projectionKey} 的查询，测试前提不成立`)
  return new PgDialect().sqlToQuery(found.condition as never)
}

describe('deriveTitle', () => {
  it('取第一条用户消息的正文', () => {
    const messages = [assistantMessage('a1', '你好'), userMessage('u1', '帮我配一身上班穿的')]

    expect(deriveTitle(messages)).toBe('帮我配一身上班穿的')
  })

  it('剥掉标注行 —— 否则工作台提交的标题会是一行机器文本', () => {
    const messages = [
      userMessage('u1', '帮我试试这件\n[附件] 服装图 assetId=11111111-1111-1111-1111-111111111111'),
    ]

    expect(deriveTitle(messages)).toBe('帮我试试这件')
  })

  it('整条消息只有标注时返回 null，而不是把标注当标题', () => {
    const messages = [
      userMessage('u1', '[选择] 服装 garmentId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    ]

    expect(deriveTitle(messages)).toBeNull()
  })

  it('只传图没打字时返回 null，交给界面回退成时间', () => {
    expect(deriveTitle([userMessage('u1', '   ')])).toBeNull()
  })

  it('过长的标题截断并加省略号', () => {
    const long = '一'.repeat(80)
    const title = deriveTitle([userMessage('u1', long)]) ?? ''

    // TITLE_MAX 是 40，加一个省略号
    expect(title).toHaveLength(41)
    expect(title.endsWith('…')).toBe(true)
  })

  it('恰好等于上限时不加省略号', () => {
    const exact = '一'.repeat(40)

    expect(deriveTitle([userMessage('u1', exact)])).toBe(exact)
  })

  it('一条消息都没有时返回 null', () => {
    expect(deriveTitle([])).toBeNull()
  })
})

describe('ensureConversation 的归属校验', () => {
  it('已存在且属于本会话 → 放行', async () => {
    dbHolder.selects = [[{ sessionId: SESSION }]]

    await expect(ensureConversation(SESSION, CONVERSATION)).resolves.toBe(true)
  })

  it('已存在但属于别人 → 拒绝，而不是新开一个同 id 的', async () => {
    dbHolder.selects = [[{ sessionId: OTHER_SESSION }]]

    await expect(ensureConversation(SESSION, CONVERSATION)).resolves.toBe(false)
    // 拒绝时不能顺手建行：那会让一次被拒的请求仍然留下痕迹
    expect(insertCalls).toHaveLength(0)
  })

  it('不存在 → 以客户端给的 id 建行，并把会话挂上去', async () => {
    dbHolder.selects = [[]]

    await expect(ensureConversation(SESSION, CONVERSATION)).resolves.toBe(true)

    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0].values).toMatchObject({ id: CONVERSATION, sessionId: SESSION })
    // 并发下两个请求带同一个新 id 进来时，只有一条能插进去且另一条不抛
    expect(insertCalls[0].conflict).toEqual({ doNothing: true })
  })
})

describe('saveConversation 的幂等', () => {
  const batch = [userMessage('u1', '你好'), assistantMessage('a1', '在的')]

  it('用 onConflictDoUpdate 而不是普通 insert', async () => {
    await saveConversation(CONVERSATION, batch)

    // 少了冲突处理，第二轮把整段历史重发时主键冲突 → 整次落库失败，
    // 而用户看到的是一次成功的对话，只是刷新后又没了
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0].conflict).toBeDefined()
  })

  it('⚠️ 冲突时只更新 parts，不碰 seq', async () => {
    await saveConversation(CONVERSATION, batch)

    const conflict = insertCalls[0].conflict as { set: Record<string, unknown> }

    // 把 seq 写进 set 就等于每次继续对话都把历史消息重排一遍 ——
    // 表现是刷新后消息顺序变了，而没有任何报错
    expect(Object.keys(conflict.set)).toEqual(['parts'])
  })

  it('落库时带上会话归属与角色', async () => {
    await saveConversation(CONVERSATION, batch)

    const rows = insertCalls[0].values as { id: string; conversationId: string; role: string }[]

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.id)).toEqual(['u1', 'a1'])
    expect(rows.every((row) => row.conversationId === CONVERSATION)).toBe(true)
    expect(rows.map((row) => row.role)).toEqual(['user', 'assistant'])
  })

  it('标题只在还没有标题时才写', async () => {
    await saveConversation(CONVERSATION, batch)

    const titleWrite = updateCallsHolder.calls.find((call) => 'title' in call.set)

    expect(titleWrite).toBeDefined()
    // 条件里必须有 is null。否则每次继续对话都会把标题换成最新那句话，
    // 列表里所有条目都显示最后说的内容 —— 历史记录就认不出哪次是哪次
    const rendered = new PgDialect().sqlToQuery(titleWrite!.condition as never)
    expect(rendered.sql).toContain('is null')
  })

  it('空消息不写库', async () => {
    await saveConversation(CONVERSATION, [])

    expect(insertCalls).toHaveLength(0)
  })
})

describe('loadConversation', () => {
  it('归属校验带着 sessionId', async () => {
    dbHolder.selects = [[], []]

    await loadConversation(SESSION, CONVERSATION)

    const rendered = renderedWhere('title')
    expect(rendered.sql).toContain('session_id')
    expect(rendered.params).toContain(SESSION)
  })

  it('不属于本会话或不存在 → null，且不再去查消息', async () => {
    dbHolder.selects = [[]]

    await expect(loadConversation(SESSION, CONVERSATION)).resolves.toBeNull()

    // 只发生了归属那一次查询
    expect(whereCalls).toHaveLength(1)
  })

  it('取最新的若干条，而不是最旧的', async () => {
    dbHolder.selects = [[{ id: CONVERSATION, title: null }], []]

    await loadConversation(SESSION, CONVERSATION)

    const rendered = new PgDialect().sqlToQuery(orderByCalls[0] as never)
    expect(rendered.sql).toContain('seq')
    expect(rendered.sql.toLowerCase()).toContain('desc')
  })

  it('读回来的是时间正序 —— 先取最新 N 条，再翻回去', async () => {
    // 库里按 seq 倒序给：最新的一条在前
    dbHolder.selects = [
      [{ id: CONVERSATION, title: null }],
      [
        { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: '第二句回话' }] },
        { id: 'u2', role: 'user', parts: [{ type: 'text', text: '第二句问话' }] },
      ],
    ]

    const loaded = await loadConversation(SESSION, CONVERSATION)

    expect(loaded?.messages.map((m) => m.id)).toEqual(['u2', 'a2'])
  })

  it('带上 limit 去查，不然长对话会把整段拉进客户端', async () => {
    dbHolder.selects = [[{ id: CONVERSATION, title: null }], []]

    await loadConversation(SESSION, CONVERSATION, { limit: 7 })

    expect(limitCalls).toContain(7)
  })
})

describe('conversationLabel', () => {
  it('有标题就原样用它', () => {
    expect(conversationLabel('面试穿什么', '2026-10-04T04:55:57.000Z')).toBe('面试穿什么')
  })

  it('没有标题时回退到时间，而不是一行空白', () => {
    const label = conversationLabel(null, '2026-10-04T04:55:57.000Z')

    // 空字符串会让列表里出现一行看不见、点得动、也不知道是什么的东西
    expect(label).not.toBe('')
    expect(label).toContain('（未命名）')
  })

  it('时间戳解析不出来时也给出一句话', () => {
    expect(conversationLabel(null, '不是时间')).toBe('（未命名对话）')
  })

  it('时间戳里的日期真的被用上了（不是所有情况都给同一个串）', () => {
    // 不比对具体格式：那会依赖运行机器的时区，测试就会在一个跨时区的 CI 上红。
    // 比对的是"两个不同的时间给出不同的标签"这个性质
    const early = conversationLabel(null, '2026-01-02T03:04:05.000Z')
    const late = conversationLabel(null, '2026-11-12T13:14:15.000Z')

    expect(early).not.toBe(late)
  })
})

describe('listConversations', () => {
  it('只列本会话的，带着 sessionId', async () => {
    dbHolder.selects = [[]]

    await listConversations(SESSION)

    const rendered = renderedWhere('updatedAt')
    expect(rendered.sql).toContain('session_id')
    expect(rendered.params).toContain(SESSION)
  })

  it('最近更新的在前', async () => {
    dbHolder.selects = [[]]

    await listConversations(SESSION)

    const rendered = new PgDialect().sqlToQuery(orderByCalls[0] as never)
    expect(rendered.sql).toContain('updated_at')
    expect(rendered.sql.toLowerCase()).toContain('desc')
  })

  it('时间转成 ISO 串，前端不必猜拿到的是不是 Date', async () => {
    dbHolder.selects = [
      [{ id: CONVERSATION, title: '面试穿什么', updatedAt: new Date('2026-10-04T04:55:57Z') }],
    ]

    const list = await listConversations(SESSION)

    expect(list[0].updatedAt).toBe('2026-10-04T04:55:57.000Z')
  })
})
