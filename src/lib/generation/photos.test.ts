import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildPhotoCandidates, listRecentPhotos } from '@/lib/generation/photos'

/**
 * 守的是"模型到底能不能发现自己手里已经有照片"。
 *
 * 这条链路的失败形态很特别：**它不报错**。模型没有 assetId 时会礼貌地
 * 请用户重新上传，用户看不出任何异常 —— 只觉得这个 AI 有点笨。
 * 所以三种失败都得钉住：
 *
 * 1. 用途反推错了（用过的人物照被标成 unused，模型就不敢用）
 * 2. 归属过滤漏了（这条会泄露别人的照片，比笨严重得多）
 * 3. 没有上传时仍然去查用途（多两次无谓查询，且暗示实现里没做短路）
 */

const whereCalls: unknown[] = []

const { dbHolder } = vi.hoisted(() => ({
  dbHolder: {
    uploads: [] as unknown[],
    personUses: [] as unknown[],
    garmentUses: [] as unknown[],
  },
}))

let queryIndex = 0

function rowsForCurrentQuery(): unknown[] {
  queryIndex += 1
  if (queryIndex === 1) return dbHolder.uploads
  if (queryIndex === 2) return dbHolder.personUses
  return dbHolder.garmentUses
}

vi.mock('@/lib/db', () => {
  const chain: Record<string, unknown> = {}
  chain.from = () => chain
  chain.where = (condition: unknown) => {
    whereCalls.push(condition)
    return chain
  }
  chain.orderBy = () => chain
  chain.limit = async () => rowsForCurrentQuery()
  // 两次用途查询是直接 await 的，所以这个对象也得是 thenable
  chain.then = (
    onFulfilled: (rows: unknown[]) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise.resolve(rowsForCurrentQuery()).then(onFulfilled, onRejected)

  return { db: { select: () => chain, selectDistinct: () => chain } }
})

const at = (iso: string) => new Date(iso)

beforeEach(() => {
  queryIndex = 0
  whereCalls.length = 0
  dbHolder.uploads = []
  dbHolder.personUses = []
  dbHolder.garmentUses = []
})

function renderedWhereClauses() {
  const dialect = new PgDialect()
  return whereCalls.map((condition) => dialect.sqlToQuery(condition as never))
}

describe('buildPhotoCandidates：从实际用途反推这张图是什么', () => {
  const ROWS = [
    { id: 'a1', createdAt: at('2026-10-04T10:00:00Z') },
    { id: 'a2', createdAt: at('2026-10-04T11:00:00Z') },
    { id: 'a3', createdAt: at('2026-10-04T12:00:00Z') },
    { id: 'a4', createdAt: at('2026-10-04T13:00:00Z') },
  ]

  it('四种用途各自标对', () => {
    const result = buildPhotoCandidates(
      ROWS,
      new Set(['a1', 'a3']),
      new Set(['a2', 'a3']),
    )

    expect(result.map((p) => p.usage)).toEqual(['person', 'garment', 'both', 'unused'])
  })

  it('没被用过的就是 unused，而不是被默认成人物照', () => {
    /*
     * 默认成 person 是个很诱人的实现：反正用户多半是要试穿。
     * 但那会让模型拿一张**其实是服装图**的图去分析"体型"，
     * 然后自信地给出一份关于那件衣服的建议。
     */
    const result = buildPhotoCandidates([ROWS[3]], new Set(), new Set())

    expect(result[0].usage).toBe('unused')
  })

  it('Map 里没有的 id 一律当没用过 —— 归属过滤失效时这里是最后一道体现', () => {
    const result = buildPhotoCandidates(ROWS, new Set(['别人的图']), new Set())

    expect(result.every((p) => p.usage === 'unused')).toBe(true)
  })

  it('上传时间如实透传（模型要靠它让用户认出是哪张）', () => {
    const result = buildPhotoCandidates([ROWS[0]], new Set(), new Set())

    expect(result[0].uploadedAt).toEqual(at('2026-10-04T10:00:00Z'))
  })

  it('空输入给空数组，不抛错', () => {
    expect(buildPhotoCandidates([], new Set(), new Set())).toEqual([])
  })
})

describe('listRecentPhotos 的查询', () => {
  it('查上传图的那条带着 sessionId', async () => {
    dbHolder.uploads = [{ id: 'a1', createdAt: at('2026-10-04T10:00:00Z') }]

    await listRecentPhotos('sess-1', { limit: 10 })

    const uploadsQuery = renderedWhereClauses().find((r) => r.sql.includes('"assets"'))
    expect(uploadsQuery, '没有找到查 assets 的语句，测试前提不成立').toBeDefined()

    expect(uploadsQuery?.sql).toContain('session_id')
    expect(uploadsQuery?.params).toContain('sess-1')
    // 只列上传的，不把生成产物也算成"你传过的照片"
    expect(uploadsQuery?.params).toContain('upload')
  })

  it('两次用途查询都带着 sessionId', async () => {
    dbHolder.uploads = [{ id: 'a1', createdAt: at('2026-10-04T10:00:00Z') }]

    await listRecentPhotos('sess-1', { limit: 10 })

    const rendered = renderedWhereClauses()

    const generationsQuery = rendered.find((r) => r.sql.includes('"generations"'))
    const garmentsQuery = rendered.find((r) => r.sql.includes('"garments"'))

    expect(generationsQuery, '没有找到查 generations 的语句').toBeDefined()
    expect(garmentsQuery, '没有找到查 garments 的语句').toBeDefined()

    /*
     * 少了这个过滤，"这张图被用过作人物照"这个判断就能由**别人的**任务来满足 ——
     * 而那种错误的表现是"我传的图莫名其妙被标成已用过"，没有任何报错。
     */
    expect(generationsQuery?.params).toContain('sess-1')
    expect(garmentsQuery?.params).toContain('sess-1')
  })

  it('一张上传图都没有时，不去查用途', async () => {
    dbHolder.uploads = []

    const result = await listRecentPhotos('sess-1', { limit: 10 })

    expect(result).toEqual([])
    // 只应该有那一条查上传图的语句
    expect(renderedWhereClauses()).toHaveLength(1)
  })

  it('把两次用途查询的结果并到对应那张图上', async () => {
    dbHolder.uploads = [
      { id: 'a1', createdAt: at('2026-10-04T10:00:00Z') },
      { id: 'a2', createdAt: at('2026-10-04T11:00:00Z') },
    ]
    dbHolder.personUses = [{ assetId: 'a1' }]
    dbHolder.garmentUses = []

    const result = await listRecentPhotos('sess-1', { limit: 10 })

    expect(result.map((p) => [p.assetId, p.usage])).toEqual([
      ['a1', 'person'],
      ['a2', 'unused'],
    ])
  })
})
