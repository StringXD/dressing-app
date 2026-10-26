import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { buildWorkbenchItems, listWorkbenchItems } from './workbench'

/**
 * 守的是工作台清单的**两件事**：查询的归属过滤，与条目里那个 id 到底是哪个。
 *
 * 前者与 `listRecentPhotos` 同理：少了 session 过滤，网格里会出现别人的照片。
 *
 * 后者更隐蔽，也是这个文件里最值得写的一条：`batchTryOn` 要的 `garmentIds`
 * 是 `garments` 表的行 id，而网格要显示的是图片。这两个 id 都在手上，
 * 拿错一个**不会报错** —— 工具会说"找不到这件衣服"，而用户明明看见它就在网格里。
 * 这种错只能靠断言钉住。
 */

const whereCalls: { condition: unknown; projectionKeys: string[] }[] = []

const { dbHolder } = vi.hoisted(() => ({
  dbHolder: {
    uploads: [] as unknown[],
    personUses: [] as unknown[],
    garmentUses: [] as unknown[],
    garments: [] as unknown[],
    assets: [] as unknown[],
  },
}))

let distinctCalls = 0

vi.mock('@/lib/db', () => {
  const chain: Record<string, unknown> = {}
  // 按**选出的列**分派返回哪份行，而不是按调用序号：
  // 外层是 Promise.all，谁先跑到 `.limit()` 取决于微任务调度，
  // 按序号写死会让测试在无关改动下随机变红
  let projectionKeys: string[] = []
  let isDistinct = false

  function responseFor(): unknown[] {
    if (isDistinct) {
      distinctCalls += 1
      // 两次 distinct 都是同步发起的，顺序有保证：先人物用途，后服装用途
      return distinctCalls === 1 ? dbHolder.personUses : dbHolder.garmentUses
    }
    if (projectionKeys.includes('storageKey')) return dbHolder.assets
    if (projectionKeys.includes('photoType')) return dbHolder.garments
    return dbHolder.uploads
  }

  chain.from = () => chain
  chain.where = (condition: unknown) => {
    // 投影和条件一起记下来。只按 SQL 找会认错对象：
    // `listRecentPhotos` 里数"服装用途"的那条**也查 garments 表、也带 session_id**，
    // `rendered.sql.includes('"garments"')` 会先匹配到它 —— 于是那条断言
    // 在"服装清单这条根本没带 sessionId"时照样全绿。投影才是这个查询的身份。
    whereCalls.push({ condition, projectionKeys: [...projectionKeys] })
    return chain
  }
  chain.orderBy = () => chain
  chain.limit = () => Promise.resolve(responseFor())
  // 直接 await 的那几条（用途查询、URL 查询）需要这个对象也是 thenable
  chain.then = (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (r: unknown) => unknown) =>
    Promise.resolve(responseFor()).then(onFulfilled, onRejected)

  const select = (distinct: boolean) => (projection?: Record<string, unknown>) => {
    projectionKeys = projection ? Object.keys(projection) : []
    isDistinct = distinct
    return chain
  }

  return { db: { select: select(false), selectDistinct: select(true) } }
})

const at = (iso: string) => new Date(iso)

beforeEach(() => {
  whereCalls.length = 0
  distinctCalls = 0
  dbHolder.uploads = [{ id: 'asset-person', createdAt: at('2026-10-04T04:00:00Z') }]
  dbHolder.personUses = [{ assetId: 'asset-person' }]
  dbHolder.garmentUses = []
  dbHolder.garments = [
    { id: 'garment-1', assetId: 'asset-shirt', title: '白衬衫', color: '白', photoType: 'flat-lay' },
  ]
  dbHolder.assets = [
    { id: 'asset-person', storageKey: 'uploads/s1/person.png' },
    { id: 'asset-shirt', storageKey: 'uploads/s1/shirt.png' },
  ]
})

/**
 * 按**投影**（这条查询选了哪些列）取出它的 where 条件并渲染成 SQL。
 *
 * 不能改用表名或列名去 find：同一个函数里会有两处查询命中同一种写法，
 * 那时 find 会挑到另一条，断言就在测一个无关的东西 —— 而它是绿的。
 * 找不到时直接抛：测试前提不成立必须红，不能静默跳过。
 */
function renderedWhere(projectionKey: string) {
  const found = whereCalls.find((call) => call.projectionKeys.includes(projectionKey))
  if (!found) throw new Error(`没有选了 ${projectionKey} 的查询，测试前提不成立`)
  return new PgDialect().sqlToQuery(found.condition as never)
}

describe('工作台清单的归属过滤', () => {
  it('查服装清单的那条带着 sessionId', async () => {
    await listWorkbenchItems('sess-1')

    const query = renderedWhere('photoType')

    expect(query.sql).toContain('session_id')
    expect(query.params).toContain('sess-1')
  })

  it('取图片地址的那条也带着 sessionId，不是只靠上游查干净了', async () => {
    await listWorkbenchItems('sess-1')

    const query = renderedWhere('storageKey')

    expect(query.sql).toContain('session_id')
    expect(query.params).toContain('sess-1')
  })

  it('一条素材都没有时不去查图片地址 —— 空 in 白跑一次往返', async () => {
    dbHolder.uploads = []
    dbHolder.garments = []

    const items = await listWorkbenchItems('sess-1')

    expect(items).toEqual({ people: [], garments: [] })

    expect(whereCalls.some((call) => call.projectionKeys.includes('storageKey'))).toBe(false)
  })
})

describe('buildWorkbenchItems：网格里能出现什么', () => {
  const urls = new Map([
    ['asset-person', '/files/uploads/s1/person.png'],
    ['asset-shirt', '/files/uploads/s1/shirt.png'],
    ['asset-unused', '/files/uploads/s1/mystery.png'],
  ])

  const garmentRows = [
    { id: 'garment-1', assetId: 'asset-shirt', title: '白衬衫', color: '白', photoType: 'flat-lay' as const },
  ]

  it('从没用过的图不进人物照网格 —— 我们连它是不是全身照都不知道', () => {
    const items = buildWorkbenchItems(
      [{ assetId: 'asset-unused', uploadedAt: at('2026-10-04T04:00:00Z'), usage: 'unused' }],
      [],
      urls,
    )

    expect(items.people).toEqual([])
  })

  it('既当过人物照又当过服装的，两栏里都该出现', () => {
    const items = buildWorkbenchItems(
      [{ assetId: 'asset-person', uploadedAt: at('2026-10-04T04:00:00Z'), usage: 'both' }],
      [],
      urls,
    )

    expect(items.people).toHaveLength(1)
  })

  it('只当过服装的上传图不进人物照网格', () => {
    const items = buildWorkbenchItems(
      [{ assetId: 'asset-shirt', uploadedAt: at('2026-10-04T04:00:00Z'), usage: 'garment' }],
      [],
      urls,
    )

    expect(items.people).toEqual([])
  })

  it('garmentId 用的是 garments 行的 id，不是 assetId', async () => {
    const items = await listWorkbenchItems('sess-1')

    expect(items.garments).toHaveLength(1)
    expect(items.garments[0].garmentId).toBe('garment-1')
    // 拿错的那个会静默失败：工具说"找不到这件衣服"，而它就在网格里
    expect(items.garments[0].garmentId).not.toBe(items.garments[0].assetId)
  })

  it('服装的标题与颜色如实透传，网格才显示得出它是什么', () => {
    const items = buildWorkbenchItems([], garmentRows, urls)

    expect(items.garments[0].title).toBe('白衬衫')
    expect(items.garments[0].color).toBe('白')
    expect(items.garments[0].photoType).toBe('flat-lay')
  })

  it('两个 id 都留下 —— 显示用 assetId，提交用 garmentId', async () => {
    const items = await listWorkbenchItems('sess-1')

    expect(items.garments[0].assetId).toBe('asset-shirt')
    // 用的是真实 storage 适配器（这里没 mock 它），所以顺带钉住了
    // "地址一定经 storage.url 出海"这件事 —— 自己拼路径的话，
    // 存储后端一换就会在界面上变成一堆 404
    expect(items.garments[0].url).toBe('/api/files/uploads/s1/shirt.png')
  })

  it('取不到地址的条目丢掉，不会渲染成一个点不动的空格子', () => {
    const items = buildWorkbenchItems([], garmentRows, new Map())

    expect(items.garments).toEqual([])
  })

  it('人物照带上上传时间，界面要靠它让用户认出是哪张', async () => {
    const items = await listWorkbenchItems('sess-1')

    expect(items.people[0].assetId).toBe('asset-person')
    expect(items.people[0].uploadedAt).toBe('2026-10-04T04:00:00.000Z')
  })
})
