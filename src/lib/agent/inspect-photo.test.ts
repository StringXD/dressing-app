import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAgentTools } from '@/lib/agent/tools'

/**
 * 守的是**预检到底有没有在花钱之前发生**。
 *
 * 这个工具的价值全在"提前"两个字上：它晚一步，用户就已经付过 $0.075 了。
 * 而它的失败形态同样是安静的 —— 结论照样返回，只是返回得太晚，
 * 界面上看不出任何区别。
 */

const { dbHolder, whereCalls, storageGet, generateObjectSpy, findAssessment, recordAssessment } =
  vi.hoisted(() => ({
    dbHolder: { rows: [] as unknown[] },
    /** 记下每次 .where() 的条件，用来断言**查询本身**真的按会话过滤了 */
    whereCalls: [] as unknown[],
    storageGet: vi.fn(async () => ({ body: Buffer.from('bytes'), mime: 'image/webp' })),
    generateObjectSpy: vi.fn(async (_args: { prompt?: string; schema?: unknown }) => ({
      object: {
        hasPerson: true,
        framing: 'full-body',
        clarity: 'sharp',
        notes: '全身入镜',
        advice: [],
      } as Record<string, unknown>,
    })),
    findAssessment: vi.fn(),
    /*
     * 参数类型必须显式写出来。
     *
     * `vi.fn(async () => …)` 会把参数推断成**零元组**，于是 `mock.calls[0][1]`
     * 在类型上根本不存在 —— 断言写得出来，tsc 却过不去。
     */
    recordAssessment: vi.fn(
      async (
        _sessionId: string,
        _target: { kind: string; assetId?: string; generationId?: string },
        _modelId: string,
        _payload: Record<string, unknown>,
      ) => undefined,
    ),
  }),
)

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

vi.mock('@/lib/agent/model', () => ({
  getAgentModel: () => ({}) as never,
  AGENT_MODEL_ID: 'mock-model',
}))

vi.mock('@/lib/storage', () => ({ storage: { get: storageGet } }))

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateObject: generateObjectSpy,
}))

vi.mock('@/lib/generation/assessments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/generation/assessments')>()),
  findAssessment,
  recordAssessment,
}))

const SMALL_ASSET = {
  id: 'asset-1',
  sessionId: 'sess-1',
  storageKey: 'uploads/person.webp',
  width: 270,
  height: 360,
}

const BIG_ASSET = { ...SMALL_ASSET, width: 1200, height: 1600 }

const tools = () => createAgentTools({ sessionId: 'sess-1' })

beforeEach(() => {
  dbHolder.rows = [BIG_ASSET]
  whereCalls.length = 0
  generateObjectSpy.mockClear()
  recordAssessment.mockClear()
  storageGet.mockClear()
  findAssessment.mockReset()
  findAssessment.mockResolvedValue(null)
})

describe('inspectPhoto：几何检查不需要模型', () => {
  it('尺寸太小的小图，即使模型说"全身清晰"也照样报出来', async () => {
    dbHolder.rows = [SMALL_ASSET]

    const result = (await tools().inspectPhoto.execute!({ assetId: 'asset-1', role: 'person' }, {} as never)) as {
      level: string
      issues: { code: string }[]
    }

    /*
     * 这条守的是"两层各自独立"。把几何结论换成"模型说没问题就没问题"
     * 是个很自然的简化，而它恰好会放过尺寸这一档 ——
     * 模型看 270×360 的图完全可能说"全身、清晰"，但那张图的**输出会一样小**。
     */
    expect(result.level).toBe('poor')
    expect(result.issues.map((i) => i.code)).toContain('low-resolution')
  })
})

describe('inspectPhoto：服装图不套人物检查', () => {
  it('role=garment 时一次模型调用都不发生', async () => {
    const result = (await tools().inspectPhoto.execute!(
      { assetId: 'asset-1', role: 'garment' },
      {} as never,
    )) as { check: unknown; level: string }

    expect(result.check).toBeNull()
    expect(result.level).toBe('ok')

    /*
     * 对服装图跑"图里有没有人"会得到一条假警报。假警报比不检查更糟：
     * 它教模型忽略这个工具，下次真正的警报也就没人当回事了。
     */
    expect(generateObjectSpy).not.toHaveBeenCalled()
  })
})

describe('inspectPhoto：不重复付费', () => {
  it('没有缓存时调模型一次，并以 photo 这个 kind 落库', async () => {
    await tools().inspectPhoto.execute!({ assetId: 'asset-1', role: 'person' }, {} as never)

    expect(generateObjectSpy).toHaveBeenCalledTimes(1)
    // kind 写错会让结论存进别的槽位，而唯一索引是 (kind, asset_id)
    expect(recordAssessment.mock.calls[0][1]).toEqual({ kind: 'photo', assetId: 'asset-1' })
  })

  it('有缓存时不调模型，并如实标出这是上次的结论', async () => {
    const analyzedAt = new Date('2026-10-04T05:00:00Z')
    findAssessment.mockResolvedValue({
      payload: { hasPerson: true, framing: 'half-body', clarity: 'sharp', notes: '半身', advice: [] },
      modelId: 'mock-model',
      createdAt: analyzedAt,
    })

    const result = (await tools().inspectPhoto.execute!({ assetId: 'asset-1', role: 'person' }, {} as never)) as {
      fromCache: boolean
      analyzedAt: Date
      level: string
    }

    expect(generateObjectSpy).not.toHaveBeenCalled()
    expect(recordAssessment).not.toHaveBeenCalled()
    expect(result.fromCache).toBe(true)
    expect(result.analyzedAt).toEqual(analyzedAt)
    // 缓存的结论仍要与**当前**尺寸合成 —— 尺寸是即时读的，不走缓存
    expect(result.level).toBe('warning')
  })

  it('缓存里的 payload 形状对不上时，重新检查而不是照旧报一个坏结论', async () => {
    findAssessment.mockResolvedValue({
      payload: { 这不是: '一份检查结论' },
      modelId: 'mock-model',
      createdAt: new Date(),
    })

    await tools().inspectPhoto.execute!({ assetId: 'asset-1', role: 'person' }, {} as never)

    expect(generateObjectSpy).toHaveBeenCalledTimes(1)
  })
})

describe('inspectPhoto：归属校验', () => {
  it('别人的图直接抛错，且**一次模型调用都不发生**', async () => {
    // 归属过滤在 SQL 里，桩对任何条件都返回空数组，即"查不到"
    dbHolder.rows = []

    await expect(
      tools().inspectPhoto.execute!(
        { assetId: 'asset-of-someone-else', role: 'person' },
        {} as never,
      ),
    ).rejects.toThrow(/找不到图片/)

    /*
     * "不调用模型"这一半不能省。宽高本身就是关于别人照片的信息，
     * 而内容检查更会真的把别人的图发给模型 —— 那是双重泄露。
     */
    expect(generateObjectSpy).not.toHaveBeenCalled()
  })

  it('取资产的那条查询**真的**按会话过滤了，而不是只靠桩返回空数组', async () => {
    /*
     * 上一条有个空测隐患：桩不管条件是什么都返回同一个数组，所以把
     * `eq(assets.sessionId)` 删掉，上一条照样通过 —— "查不到"与"没过滤"
     * 在桩里长得一模一样。
     *
     * 归属过滤是靠 SQL 实现的，那么断言就该落在 SQL 上。
     * 这条守的是 `requireOwnedAsset` —— 十二个工具共用的那个函数，
     * 它一旦漏掉过滤，泄露的不是一张图，是所有人的图与结论。
     */
    const dialect = new PgDialect()
    whereCalls.length = 0

    await tools().inspectPhoto.execute!({ assetId: 'asset-1', role: 'person' }, {} as never)

    const rendered = whereCalls.map((condition) => dialect.sqlToQuery(condition as never))
    const assetQuery = rendered.find((r) => r.params.includes('asset-1'))

    expect(assetQuery, '没有找到取资产的语句，测试前提不成立').toBeDefined()
    expect(assetQuery!.sql).toContain('session_id')
    expect(assetQuery!.params).toContain('sess-1')
  })
})
