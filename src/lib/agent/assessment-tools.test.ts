import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SPENDING_TOOL_APPROVAL, createAgentTools } from '@/lib/agent/tools'

/**
 * 这一组守两件**都不会报错、只在账单或安全上体现**的事：
 *
 * 1. **不重复付费**：同一张照片上的同一种分析只该算一次。缓存判断写错的表现
 *    是用户被静默地多收一次 token 费，界面上看不出任何异常。
 * 2. **闸门归属**：这三个工具不花图像成本，不该进审批闸门；进了的话，
 *    用户会为几厘钱点确认 —— 那会让"确认"这个动作贬值，
 *    而它本来只在真正扣大钱时才该出现。
 */

const { dbHolder, whereCalls, storageGet, generateObjectSpy, findAssessment, recordAssessment } =
  vi.hoisted(() => ({
    dbHolder: { rows: [] as unknown[] },
    /** 记下每次 .where() 的条件，用来断言"查询确实按会话过滤了" */
    whereCalls: [] as unknown[],
    storageGet: vi.fn(async () => ({
      body: Buffer.from('fake-bytes'),
      mime: 'image/webp',
    })),
    generateObjectSpy: vi.fn(async () => ({ object: { shape: 'pear' } })),
    findAssessment: vi.fn(),
    recordAssessment: vi.fn(async () => undefined),
  }))

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          whereCalls.push(condition)
          return { limit: async () => dbHolder.rows }
        },
      }),
    }),
  },
}))

// getAgentModel 会校验 ANTHROPIC_API_KEY，单测里不需要真模型
// （generateObject 已被桩掉，模型对象根本用不到），与 chat.test.ts 同款处理
vi.mock('@/lib/agent/model', () => ({
  getAgentModel: () => ({}) as never,
  AGENT_MODEL_ID: 'mock-model',
}))

vi.mock('@/lib/storage', () => ({ storage: { get: storageGet } }))

// 只替换 generateObject，保留 tool 等其他导出
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateObject: generateObjectSpy,
}))

// 只替换读写缓存的两个函数，schema 与提示词用真的
vi.mock('@/lib/generation/assessments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/generation/assessments')>()),
  findAssessment,
  recordAssessment,
}))

const ASSET_ROW = {
  id: 'asset-1',
  sessionId: 'sess-1',
  storageKey: 'uploads/sess-1/person.webp',
}

const tools = () => createAgentTools({ sessionId: 'sess-1' })

describe('分析工具：不重复付费', () => {
  beforeEach(() => {
    generateObjectSpy.mockClear()
    recordAssessment.mockClear()
    storageGet.mockClear()
    findAssessment.mockReset()
  })

  it('没有缓存时调用模型，并落库', async () => {
    findAssessment.mockResolvedValue(null)
    dbHolder.rows = [ASSET_ROW]

    const result = (await tools().analyzeBodyShape.execute!(
      { personAssetId: 'asset-1' },
      {} as never,
    )) as Record<string, unknown>

    // 先证明"确实走了分析这条路"。少了这句，下面"落库了"在
    // 模型压根没被调用的坏实现下也会成立 —— 空测。
    expect(generateObjectSpy).toHaveBeenCalledTimes(1)
    expect(recordAssessment).toHaveBeenCalledTimes(1)
    expect(result.fromCache).toBe(false)
  })

  it('有缓存时不调用模型，并如实标出这是上次的结论', async () => {
    const analyzedAt = new Date('2026-10-04T05:00:00Z')
    findAssessment.mockResolvedValue({
      payload: { shape: 'hourglass', notes: '肩胯同宽' },
      modelId: 'mock-model',
      createdAt: analyzedAt,
    })

    const result = (await tools().analyzeBodyShape.execute!(
      { personAssetId: 'asset-1' },
      {} as never,
    )) as Record<string, unknown>

    expect(generateObjectSpy).not.toHaveBeenCalled()
    expect(recordAssessment).not.toHaveBeenCalled()
    expect(result).toMatchObject({ shape: 'hourglass', fromCache: true })
    // 把上次的结论说成刚算的会误导用户 —— 他可能刚换了发型
    expect(result.analyzedAt).toEqual(analyzedAt)
  })

  it('缓存查询带着 sessionId 与 kind —— 否则会读到别人的结论', async () => {
    findAssessment.mockResolvedValue(null)
    dbHolder.rows = [ASSET_ROW]

    await tools().analyzeColorSeason.execute!({ personAssetId: 'asset-1' }, {} as never)

    expect(findAssessment).toHaveBeenCalledWith('sess-1', {
      kind: 'season',
      assetId: 'asset-1',
    })
  })
})

describe('analysis tools：归属校验', () => {
  beforeEach(() => {
    generateObjectSpy.mockClear()
    findAssessment.mockReset()
  })

  it('critiqueOutfit 对查不到的任务（不属于本会话或不存在）必须抛错', async () => {
    // 查询本身带 eq(sessionId)，所以"不是你的"在这个桩里表现为空数组
    dbHolder.rows = []

    await expect(
      tools().critiqueOutfit.execute!({ generationId: 'gen-of-someone-else' }, {} as never),
    ).rejects.toThrow(/找不到任务/)
  })

  it('查任务的语句**真的**按会话过滤了，而不是只靠桩返回空数组', async () => {
    /*
     * 上一条测试有个空测隐患：桩不管条件是什么都返回同一个数组，
     * 所以把 eq(sessionId) 删掉，上一条照样通过。这里直接看查询条件本身 ——
     * 归属过滤是靠 SQL 实现的，那么断言就该落在 SQL 上。
     */
    dbHolder.rows = [{ outputAssetId: 'out-1' }]
    findAssessment.mockResolvedValue(null)
    whereCalls.length = 0

    await tools().critiqueOutfit.execute!({ generationId: 'gen-1' }, {} as never)

    const dialect = new PgDialect()
    const rendered = whereCalls.map((condition) => dialect.sqlToQuery(condition as never))

    /*
     * 必须**挑出查任务的那条语句**再断言，不能笼统地看"所有语句里有没有 session_id"。
     *
     * 这一点是变异检验逼出来的：critiqueOutfit 内部还会经 requireOwnedAsset
     * 查一次资产，而那条查询本来就带 session_id —— 于是把任务查询的归属过滤
     * 整个删掉，笼统的断言依然通过。测试绿着，能读到别人任务的口子却开着。
     */
    const generationQuery = rendered.find((r) => r.params.includes('gen-1'))
    expect(generationQuery, '没有找到查任务的语句，测试前提不成立').toBeDefined()

    expect(generationQuery!.params).toContain('sess-1')
    expect(generationQuery!.sql).toContain('session_id')
  })

  it('任务还没产出图片时给出可操作的提示，而不是一个语焉不详的失败', async () => {
    dbHolder.rows = [{ outputAssetId: null }]

    await expect(
      tools().critiqueOutfit.execute!({ generationId: 'gen-1' }, {} as never),
    ).rejects.toThrow(/还没有产出图片/)
  })
})

describe('闸门归属：分析工具不该进审批', () => {
  it('三个分析工具都不在 SPENDING_TOOL_APPROVAL 里', () => {
    const gated = Object.keys(SPENDING_TOOL_APPROVAL)

    // 先证明这张表不是空的 —— 否则"不在里面"对任何名字都成立
    expect(gated).toContain('enqueueTryOn')

    for (const name of ['critiqueOutfit', 'analyzeBodyShape', 'analyzeColorSeason']) {
      expect(gated).not.toContain(name)
    }
  })
})
