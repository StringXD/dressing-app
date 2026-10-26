import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listActiveGenerations } from './stats'

/**
 * 守的是 `listActiveGenerations` 的**归属过滤、状态过滤与排序**。
 *
 * 这个函数存在的理由是一个缺口：进度面板跟踪的任务列表来自前端内存里的
 * 对话消息，刷新即失 —— 正在跑的换装于是从界面上彻底消失。这个查询是
 * 那个问题的答案，所以它必须只回答问题，不多说一个字：
 *
 * - 漏掉归属过滤 → 把**别人的**任务显示在"你还有任务在跑"的标题下
 * - 漏掉状态过滤 → 已结束的任务混进"未结束"，进度条一直转
 * - 排序写反 → 任务多起来之后，显示的恰好是最旧的那批
 *
 * 前两者在界面上都表现为"看起来挺正常"，所以只能验 SQL 本身。
 */

const whereCalls: { index: number; condition: unknown }[] = []
const orderByCalls: unknown[] = []
const limitCalls: unknown[] = []

let queryIndex = 0
let infoCursor = 0

/** 第一条查询（列表）返回它，之后每两条是某个任务的"自己"与"前面还有几个" */
let listRows: unknown[] = []
let infoResponses: unknown[][] = []

vi.mock('@/lib/db', () => {
  const chain: Record<string, unknown> = {}
  chain.from = () => chain
  chain.where = (condition: unknown) => {
    queryIndex += 1
    whereCalls.push({ index: queryIndex, condition })
    return chain
  }
  chain.orderBy = (node: unknown) => {
    orderByCalls.push(node)
    return chain
  }
  chain.limit = (n: unknown) => {
    limitCalls.push(n)
    return Promise.resolve(takeRows())
  }
  // 数"前面还有几个"的那条是直接 await .where(...) 的，所以这个对象得是 thenable
  chain.then = (
    onFulfilled: (rows: unknown[]) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(takeRows()).then(onFulfilled, onRejected)

  return { db: { select: () => chain } }
})

function takeRows(): unknown[] {
  if (queryIndex === 1) return listRows
  return infoResponses[infoCursor++] ?? []
}

const SESSION = 'sess-mine'

const ACTIVE_ROW = {
  id: 'gen-mine-1',
  createdAt: new Date('2026-10-04T04:55:57Z'),
}

/** `getGenerationQueueInfo` 的两条查询：先自己，再数前面有几个 */
function infoFor(id: string, status: string, position: number, extra: object = {}) {
  return [
    [{ status, queueSeq: 10, errorCode: null, errorMessage: null, ...extra }],
    [{ value: position }],
  ]
}

beforeEach(() => {
  queryIndex = 0
  infoCursor = 0
  whereCalls.length = 0
  orderByCalls.length = 0
  limitCalls.length = 0
  listRows = [ACTIVE_ROW]
  infoResponses = [infoFor('gen-mine-1', 'queued', 2)].flat()
})

/** 只渲染指定序号的 where 条件 */
function renderedConditionAt(index: number) {
  const found = whereCalls.find((call) => call.index === index)
  if (!found) throw new Error(`没有第 ${index} 条查询，测试前提不成立`)
  return new PgDialect().sqlToQuery(found.condition as never)
}

describe('未结束任务的归属过滤', () => {
  it('列表查询带着 sessionId，不会捞出别人的任务', async () => {
    await listActiveGenerations(SESSION)

    const rendered = renderedConditionAt(1)

    expect(rendered.sql).toContain('session_id')
    expect(rendered.params).toContain(SESSION)
  })

  it('只挑未结束的状态，不把已结束的也算成"在跑"', async () => {
    await listActiveGenerations(SESSION)

    const rendered = renderedConditionAt(1)

    expect(rendered.params).toContain('queued')
    expect(rendered.params).toContain('processing')
    // 这一条是防"顺手换成 TERMINAL_STATUSES"：那样即使归属过滤是对的，
    // 面板也会把已经跑完的任务当成在跑，进度条永远停不下来
    expect(rendered.params).not.toContain('succeeded')
    expect(rendered.params).not.toContain('failed')
    expect(rendered.params).not.toContain('canceled')
  })

  it('最新的排在前面，任务多到被截断时留下的是最近那批', async () => {
    await listActiveGenerations(SESSION)

    const rendered = new PgDialect().sqlToQuery(orderByCalls[0] as never)

    expect(rendered.sql).toContain('queue_seq')
    expect(rendered.sql.toLowerCase()).toContain('desc')
  })

  it('真的会返回任务，而不是无论查什么都给空数组', async () => {
    // 没有这一条的话，上面三条断言在"函数永远返回 []"时**照样全绿** ——
    // 而界面上就是那个原始 bug 的样子：什么都没发生
    const items = await listActiveGenerations(SESSION)

    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('gen-mine-1')
    expect(items[0].status).toBe('queued')
    expect(items[0].position).toBe(2)
    expect(items[0].active).toBe(true)
  })

  it('入队时刻转成 ISO 串，前端不必猜服务端给的是不是 Date', async () => {
    const items = await listActiveGenerations(SESSION)

    // JSON 会把 Date 序列化成 ISO 串；这里显式转，等的是同一个形状。
    // 传 Date 出去的话，客户端 `new Date(value)` 在类型上过得去、运行时也碰巧对，
    // 但接口的契约就没人说得清了
    expect(items[0].createdAt).toBe('2026-10-04T04:55:57.000Z')
  })

  it('任务在查询途中消失时不炸，只是少一条', async () => {
    // 并发下真会发生：行刚查出来，任务就结束并被清理
    infoResponses = [[], []]

    const items = await listActiveGenerations(SESSION)

    expect(items).toEqual([])
  })
})
