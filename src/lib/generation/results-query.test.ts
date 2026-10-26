import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listRecentResults } from '@/lib/generation/results'

/**
 * 守的是 `listRecentResults` 里**三条查询各自的归属过滤**。
 *
 * 与 `results.test.ts` 的分工：那边测的是纯函数（查不到 key 时给 null），
 * 这边测的是 SQL 本身 —— 因为"查不到"本身也可能是因为过滤条件写错了，
 * 而两者的表现一模一样：界面上少一张图，谁都看不出区别。
 *
 * 第三条查询是这次新加的（读评价）。它是三条里**最容易被漏掉**过滤的一个：
 * 前两条从 `generations` / `assets` 出发，一看就知道该带 session_id；
 * 而 `assessments` 是通过 generation_id 关联过来的，很容易写成
 * "反正 generationId 已经是本会话的了"。但那是上游的保证，不是这条查询的 ——
 * 评价是主观判断，泄露它比泄露图片更难受。
 */

const whereCalls: unknown[] = []

const { dbHolder } = vi.hoisted(() => ({
  dbHolder: {
    generations: [] as unknown[],
    assets: [] as unknown[],
    assessments: [] as unknown[],
  },
}))

let queryIndex = 0

function rowsForCurrentQuery(): unknown[] {
  queryIndex += 1
  if (queryIndex === 1) return dbHolder.generations
  if (queryIndex === 2) return dbHolder.assets
  return dbHolder.assessments
}

vi.mock('@/lib/db', () => {
  const chain: Record<string, unknown> = {}
  chain.from = () => chain
  chain.leftJoin = () => chain
  chain.where = (condition: unknown) => {
    whereCalls.push(condition)
    return chain
  }
  chain.orderBy = () => chain
  chain.limit = async () => rowsForCurrentQuery()
  // 第三条查询是直接 `await .where(...)` 的，所以这个对象也得是 thenable
  chain.then = (
    onFulfilled: (rows: unknown[]) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(rowsForCurrentQuery()).then(onFulfilled, onRejected)

  return { db: { select: () => chain } }
})

vi.mock('@/lib/storage', () => ({
  storage: { url: (key: string) => `/files/${key}` },
}))

const GENERATION = {
  id: 'gen-1',
  taskKind: 'tryon',
  modelId: 'fal/apps-v2-tryon',
  status: 'succeeded',
  costUsd: 0.04,
  createdAt: new Date('2026-10-04T04:55:57Z'),
  outputAssetId: 'out-1',
  personAssetId: 'person-1',
  garmentId: 'garment-1',
  garmentTitle: '黑色燕尾服外套',
  garmentColor: '黑色',
}

beforeEach(() => {
  queryIndex = 0
  whereCalls.length = 0
  dbHolder.generations = [GENERATION]
  dbHolder.assets = [{ id: 'out-1', storageKey: 'generated/s1/out.png' }]
  dbHolder.assessments = []
})

/** 把每次 .where() 的条件渲染成 SQL 与参数，好按表名挑出某一條查询 */
function renderedWhereClauses() {
  const dialect = new PgDialect()
  return whereCalls.map((condition) => dialect.sqlToQuery(condition as never))
}

describe('评价查询的归属过滤', () => {
  it('读评价的那条查询带着 sessionId', async () => {
    await listRecentResults('sess-1', { limit: 5 })

    const rendered = renderedWhereClauses()
    const critiqueQuery = rendered.find((r) => r.sql.includes('assessments'))

    // 前提没成立时给出可读的失败，而不是让下面两条在 undefined 上炸掉
    expect(critiqueQuery, '没有找到查 assessments 的语句，测试前提不成立').toBeDefined()

    expect(critiqueQuery?.sql).toContain('session_id')
    expect(critiqueQuery?.params).toContain('sess-1')
  })

  it('只读 critique，不把体型/季型那些挂在 asset 上的结论也捞出来', async () => {
    await listRecentResults('sess-1', { limit: 5 })

    const critiqueQuery = renderedWhereClauses().find((r) => r.sql.includes('assessments'))

    expect(critiqueQuery?.params).toContain('critique')
    expect(critiqueQuery?.params).toContain('gen-1')
  })
})

describe('评价接进视图', () => {
  it('查到的评价翻成中文挂在那条结果上', async () => {
    dbHolder.assessments = [
      {
        generationId: 'gen-1',
        payload: {
          fit: { rating: 'good', notes: '肩线正落在肩头' },
          color: { rating: 'excellent', notes: '米白压住了肤色' },
          highlights: [],
          suggestions: ['袖长改短两公分'],
        },
      },
    ]

    const [result] = await listRecentResults('sess-1', { limit: 5 })

    expect(result.critique?.fit).toBe('合身 · 肩线正落在肩头')
    expect(result.critique?.suggestions).toEqual(['袖长改短两公分'])
  })

  it('没评价过的结果，critique 是 null —— 界面上要能安静地少渲染一块', async () => {
    dbHolder.assessments = []

    const [result] = await listRecentResults('sess-1', { limit: 5 })

    expect(result.critique).toBeNull()
  })

  it('评价挂的是别的那次生成时，不会串到这一条上', async () => {
    dbHolder.assessments = [
      {
        generationId: 'gen-别的',
        payload: { fit: { rating: 'too-tight', notes: '别人的' } },
      },
    ]

    const [result] = await listRecentResults('sess-1', { limit: 5 })

    expect(result.critique).toBeNull()
  })
})
