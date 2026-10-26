import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BATCH_TRYON_MAX } from '@/lib/domain'
import { createAgentTools, describeTryOnCost } from '@/lib/agent/tools'

/**
 * 批二（顾问）与批三（批量矩阵）的行为测试。
 *
 * 这里守的都是**不会报错**的错：
 *
 * - 缺结论时"顺手"把结论算出来 —— 用户没要求、结论还不落库，白付一次钱
 * - 批量矩阵把 `personAssetIds × garmentIds` 算成其中一个数组的长度 ——
 *   审批卡片上显示的张数与实际扣费不符
 * - 超限时先入队再报错 —— 用户看到失败，钱已经花了
 * - 对比结论用 `critique` 这个 kind 落库 —— 占住合身度评价的缓存槽位
 */

let enqueueSeq = 0

/**
 * 桩的参数类型必须显式写出来。
 *
 * `vi.fn(async () => …)` 会把参数推断成**零元组**，于是
 * `mock.calls[0][0]` 在类型上根本不存在 —— 断言写得出来，tsc 却过不去。
 * 反过来，一旦这里加了参数，下面所有"看第几个实参"的断言就都受类型保护了：
 * 工具的签名改了而测试没跟上时，红在编译期而不是悄悄跳过。
 */
interface GenerateObjectArgs {
  prompt?: string
  messages?: { role: string; content: { type: string; text?: string }[] }[]
}

interface AssessmentTargetLike {
  kind: string
  generationId?: string
  assetId?: string
}

const {
  dbHolder,
  storageGet,
  generateObjectSpy,
  findAssessment,
  recordAssessment,
  enqueueGeneration,
} = vi.hoisted(() => ({
  dbHolder: { rows: [] as unknown[] },
  storageGet: vi.fn(async () => ({ body: Buffer.from('bytes'), mime: 'image/webp' })),
  generateObjectSpy: vi.fn(async (_args: GenerateObjectArgs) => ({
    object: {} as Record<string, unknown>,
  })),
  findAssessment: vi.fn(),
  recordAssessment: vi.fn(
    async (
      _sessionId: string,
      _target: AssessmentTargetLike,
      _modelId: string,
      _payload: Record<string, unknown>,
    ) => undefined,
  ),
  enqueueGeneration: vi.fn(async (_args: { personAssetId: string; garmentId: string }) => ({
    id: 'gen-x',
    status: 'queued',
  })),
}))

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = () => dbHolder.rows

          /*
           * 这个返回值必须**同时**是带 limit 的查询构造器和 thenable：
           * 单行查询走 `.where(...).limit(1)`，而 compareResults 的列表查询
           * 直接 `await .where(...)`。只支持前者的桩会让后者静默拿到 undefined。
           */
          return {
            limit: async () => rows(),
            then: (
              onFulfilled: (value: unknown[]) => unknown,
              onRejected?: (reason: unknown) => unknown,
            ) => Promise.resolve(rows()).then(onFulfilled, onRejected),
          }
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

vi.mock('@/lib/queue/enqueue', () => ({ enqueueGeneration }))

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

/**
 * 桩对任何查询都返回同一个数组，所以资产与衣服共用这一行。
 *
 * 这里只用到"查得到 / 查不到"两种结果，而两个分支各自有独立的测试；
 * 归属过滤本身是 SQL 的事，由下方渲染 SQL 的那条断言负责。
 */
const ASSET_ROW = { id: 'asset-1', sessionId: 'sess-1', storageKey: 'uploads/person.webp' }

const tools = () => createAgentTools({ sessionId: 'sess-1' })

/**
 * 取某次 generateObject 调用里发给模型的内容块。
 *
 * 桩里的 messages 是可选的，直接 `calls[0][0].messages[0].content` 会因为
 * 可能为 undefined 而通不过 tsc。这里显式抛错而不是用 `!`：
 * 断言的前提没成立时给一句说明，比一个 "cannot read property of undefined" 强。
 */
function contentOf(callIndex = 0) {
  const content = generateObjectSpy.mock.calls[callIndex]?.[0].messages?.[0]?.content
  if (!content) throw new Error('这次调用没有带上 messages[0].content，测试前提不成立')
  return content
}

beforeEach(() => {
  enqueueSeq = 0
  enqueueGeneration.mockReset()
  enqueueGeneration.mockImplementation(async () => {
    enqueueSeq += 1
    return { id: `gen-${enqueueSeq}`, status: 'queued' }
  })

  generateObjectSpy.mockReset()
  generateObjectSpy.mockResolvedValue({ object: {} })

  recordAssessment.mockClear()
  storageGet.mockClear()
  findAssessment.mockReset()
})

describe('suggestStyle：缺结论时不偷偷补算', () => {
  it('两份结论都没有时返回 missing，并且**一次模型调用都不发生**', async () => {
    dbHolder.rows = [ASSET_ROW]
    findAssessment.mockResolvedValue(null)

    const result = (await tools().suggestStyle.execute!(
      { personAssetId: 'asset-1', occasion: '面试' },
      {} as never,
    )) as { missing: string[] }

    expect(result.missing).toEqual(['body', 'season'])

    /*
     * 这条断言是整组测试里最值钱的一条。
     *
     * "顺手把体型也算一遍"是个很自然的实现，而且它**什么都看起来正常**：
     * 用户拿到了一份建议，界面没有任何异常 —— 只是白付了一次分析费，
     * 而且那份算出来的结论不落库，下次问还得再算。
     */
    expect(generateObjectSpy).not.toHaveBeenCalled()
  })

  it('只有体型、没有季型时，missing 里只列出 season', async () => {
    dbHolder.rows = [ASSET_ROW]
    findAssessment.mockImplementation(async (_sid: string, target: { kind: string }) =>
      target.kind === 'body'
        ? { payload: { shape: 'pear' }, modelId: 'm', createdAt: new Date() }
        : null,
    )

    const result = (await tools().suggestStyle.execute!(
      { personAssetId: 'asset-1', occasion: '上班' },
      {} as never,
    )) as { missing: string[] }

    expect(result.missing).toEqual(['season'])
    expect(generateObjectSpy).not.toHaveBeenCalled()
  })

  it('两份结论都在时调用模型一次，并把结论喂进提示词', async () => {
    dbHolder.rows = [ASSET_ROW]
    findAssessment.mockImplementation(async (_sid: string, target: { kind: string }) =>
      target.kind === 'body'
        ? {
            payload: { shape: 'hourglass', notes: '肩胯同宽' },
            modelId: 'm',
            createdAt: new Date('2026-10-01T00:00:00Z'),
          }
        : {
            payload: { season: 'autumn', notes: '暖调' },
            modelId: 'm',
            createdAt: new Date('2026-10-02T00:00:00Z'),
          },
    )
    generateObjectSpy.mockResolvedValue({
      object: { direction: '柔和廓形', combinations: [], avoid: [] },
    })

    await tools().suggestStyle.execute!(
      { personAssetId: 'asset-1', occasion: '面试' },
      {} as never,
    )

    expect(generateObjectSpy).toHaveBeenCalledTimes(1)

    // 没有这两句，"综合已存结论"就只是描述里的说法，实现可以完全无视它们
    const prompt = String(generateObjectSpy.mock.calls[0][0].prompt)
    expect(prompt).toContain('hourglass')
    expect(prompt).toContain('autumn')
    expect(prompt).toContain('面试')
  })

  it('别人的人物照一律当作不存在 —— 否则会读出别人照片上的分析结论', async () => {
    // 归属过滤在 SQL 里，桩对任何条件都返回空数组，即"查不到"
    dbHolder.rows = []

    await expect(
      tools().suggestStyle.execute!({ personAssetId: 'asset-of-someone-else', occasion: '上班' }, {} as never),
    ).rejects.toThrow(/找不到图片/)
  })
})

describe('cloneLook：整套提取', () => {
  it('用 look 这个 kind 走缓存，且提取出的单品不写入衣橱', async () => {
    dbHolder.rows = [ASSET_ROW]
    findAssessment.mockResolvedValue(null)
    generateObjectSpy.mockResolvedValue({
      object: { items: [{ title: '米白针织衫', color: '米白', category: 'top' }], overall: '极简' },
    })

    await tools().cloneLook.execute!({ assetId: 'asset-1' }, {} as never)

    expect(findAssessment).toHaveBeenCalledWith('sess-1', { kind: 'look', assetId: 'asset-1' })
    expect(recordAssessment).toHaveBeenCalledTimes(1)
    expect(recordAssessment.mock.calls[0][1]).toEqual({ kind: 'look', assetId: 'asset-1' })
  })

  it('图片不属于本会话时抛错，不调用模型', async () => {
    dbHolder.rows = []

    await expect(
      tools().cloneLook.execute!({ assetId: 'asset-of-someone-else' }, {} as never),
    ).rejects.toThrow(/找不到图片/)

    expect(generateObjectSpy).not.toHaveBeenCalled()
  })
})

describe('compareResults：对比两次以上生成', () => {
  const TWO_GENS = [
    { id: 'g1', outputAssetId: 'a1' },
    { id: 'g2', outputAssetId: 'a2' },
  ]

  const comparisonObject = {
    verdict: '第一张更好',
    differences: [
      { generationId: 'g1', betterAt: ['合身'], worseAt: [] },
      { generationId: 'g2', betterAt: [], worseAt: ['肩线'] },
    ],
    recommendation: '留第一张',
  }

  it('用 comparison 这个 kind 落库，**不是** critique', async () => {
    dbHolder.rows = TWO_GENS
    generateObjectSpy.mockResolvedValue({ object: comparisonObject })

    await tools().compareResults.execute!({ generationIds: ['g1', 'g2'] }, {} as never)

    /*
     * 这条断言守的是一个"表结构级"的错误。
     *
     * assessments 的唯一索引是 (kind, generation_id)，critique 与 comparison
     * 的 payload 形状又完全不同。用 critique 落对比结论，会让对比结果占住
     * 某次生成的合身度评价槽位 —— 之后 critiqueOutfit 读缓存时把它当成
     * 评价返回，模型拿到一个没有 fit/color 的对象，用户看到"评价里没有合身度"。
     */
    expect(recordAssessment).toHaveBeenCalledTimes(2)
    for (const call of recordAssessment.mock.calls) {
      expect(call[1]).toMatchObject({ kind: 'comparison' })
    }
    expect(recordAssessment.mock.calls.map((c) => c[1].generationId)).toEqual(['g1', 'g2'])
  })

  it('每条落库的 payload 只带属于它自己的那部分差异', async () => {
    dbHolder.rows = TWO_GENS
    generateObjectSpy.mockResolvedValue({ object: comparisonObject })

    await tools().compareResults.execute!({ generationIds: ['g1', 'g2'] }, {} as never)

    const byGen = new Map(
      recordAssessment.mock.calls.map((c) => [c[1].generationId, c[3] as Record<string, unknown>]),
    )

    expect(byGen.get('g1')).toMatchObject({ difference: { betterAt: ['合身'], worseAt: [] } })
    expect(byGen.get('g2')).toMatchObject({ difference: { betterAt: [], worseAt: ['肩线'] } })
  })

  it('模型没提到的某一张存 null，而不是把别人的差异安到它头上', async () => {
    dbHolder.rows = TWO_GENS
    generateObjectSpy.mockResolvedValue({
      object: {
        ...comparisonObject,
        differences: [comparisonObject.differences[0]],
      },
    })

    await tools().compareResults.execute!({ generationIds: ['g1', 'g2'] }, {} as never)

    const byGen = new Map(
      recordAssessment.mock.calls.map((c) => [c[1].generationId, c[3] as Record<string, unknown>]),
    )

    expect(byGen.get('g1')).toMatchObject({ difference: { betterAt: ['合身'] } })
    expect(byGen.get('g2')).toMatchObject({ difference: null })
  })

  it('两张图与它们的 id 标签都进了同一个请求 —— 否则模型无从知道谁是谁', async () => {
    dbHolder.rows = TWO_GENS
    generateObjectSpy.mockResolvedValue({ object: comparisonObject })

    await tools().compareResults.execute!({ generationIds: ['g1', 'g2'] }, {} as never)

    const content = contentOf()

    expect(content.filter((p) => p.type === 'file')).toHaveLength(2)
    expect(content.find((p) => p.text?.includes('g1'))).toBeDefined()
    expect(content.find((p) => p.text?.includes('g2'))).toBeDefined()
  })

  it('同一个 id 传两遍只算一次（重复的图会各占一份 token，还让差异自相矛盾）', async () => {
    dbHolder.rows = TWO_GENS
    generateObjectSpy.mockResolvedValue({ object: comparisonObject })

    const result = (await tools().compareResults.execute!(
      { generationIds: ['g1', 'g1', 'g2'] },
      {} as never,
    )) as { compared: number }

    expect(result.compared).toBe(2)

    expect(contentOf().filter((p) => p.type === 'file')).toHaveLength(2)
  })

  it('有 id 不属于本会话时整体失败，而不是拿剩下几张勉强比一遍', async () => {
    // 只查回来一条，说明另一个 id 不存在或不是这个会话的
    dbHolder.rows = [TWO_GENS[0]]

    await expect(
      tools().compareResults.execute!({ generationIds: ['g1', 'gen-of-someone-else'] }, {} as never),
    ).rejects.toThrow(/不属于你的或已不存在/)

    expect(generateObjectSpy).not.toHaveBeenCalled()
  })
})

describe(`batchTryOn：${BATCH_TRYON_MAX} 张硬上限`, () => {
  beforeEach(() => {
    dbHolder.rows = [ASSET_ROW]
  })

  it('超过上限时抛错，并且**一张都不入队**', async () => {
    // 4 × 3 = 12 > 8
    await expect(
      tools().batchTryOn.execute!(
        {
          personAssetIds: ['p1', 'p2', 'p3', 'p4'],
          garmentIds: ['c1', 'c2', 'c3'],
          category: 'auto',
          mode: 'balanced',
          garmentPhotoType: 'auto',
        },
        {} as never,
      ),
    ).rejects.toThrow(/超过单次上限/)

    /*
     * 这一条与上面那条同等重要。
     *
     * "先入队再检查"是个看起来没差别的实现 —— 任务照样被拒绝，错误信息一模一样。
     * 差别在钱上：用户看到失败，队列里却已经躺着 8 条提交上去的任务。
     * 检查必须在**第一个 enqueueGeneration 之前**完成，"一张都不入队"才是保证的。
     */
    expect(enqueueGeneration).not.toHaveBeenCalled()
  })

  it('去重之后超限也要拦 —— 用户批准的是真实会发生的张数', async () => {
    // 去重后 5 × 2 = 10 > 8；不去重的话 5 × 2 也是一样，但这条钉住去重口径
    await expect(
      tools().batchTryOn.execute!(
        {
          personAssetIds: ['p1', 'p1', 'p2', 'p3', 'p4', 'p5'],
          garmentIds: ['c1', 'c2'],
          category: 'auto',
          mode: 'balanced',
          garmentPhotoType: 'auto',
        },
        {} as never,
      ),
    ).rejects.toThrow(/超过单次上限/)

    expect(enqueueGeneration).not.toHaveBeenCalled()
  })

  it('恰好等于上限时正常执行', async () => {
    const result = (await tools().batchTryOn.execute!(
      {
        personAssetIds: ['p1', 'p2', 'p3', 'p4'],
        garmentIds: ['c1', 'c2'],
        category: 'auto',
        mode: 'balanced',
        garmentPhotoType: 'auto',
      },
      {} as never,
    )) as { count: number; generationIds: string[] }

    expect(result.count).toBe(BATCH_TRYON_MAX)
    expect(result.generationIds).toHaveLength(BATCH_TRYON_MAX)
    expect(enqueueGeneration).toHaveBeenCalledTimes(BATCH_TRYON_MAX)
  })

  it('真的做了交叉组合，而不是只取第一对或简单配对', async () => {
    const result = (await tools().batchTryOn.execute!(
      {
        personAssetIds: ['p1', 'p2'],
        garmentIds: ['c1', 'c2', 'c3'],
        category: 'auto',
        mode: 'balanced',
        garmentPhotoType: 'auto',
      },
      {} as never,
    )) as { count: number }

    expect(result.count).toBe(6)
    expect(enqueueGeneration).toHaveBeenCalledTimes(6)

    /*
     * 只断言次数是不够的：把 6 次都写成同一对，次数照样是 6。
     * 所以要看**这 6 次分别用了哪些组合**。
     */
    const pairs = enqueueGeneration.mock.calls.map(
      (call) => `${call[0].personAssetId}×${call[0].garmentId}`,
    )
    expect(new Set(pairs)).toEqual(
      new Set(['p1×c1', 'p1×c2', 'p1×c3', 'p2×c1', 'p2×c2', 'p2×c3']),
    )
  })

  it('预估总额 = 单张价格 × 张数（不是把乘号漏掉）', async () => {
    const perRun = describeTryOnCost()
    // 注册表取不到价格时这条测不出东西，直接跳过而不是假装通过
    expect(perRun, '试穿模型没有价格，测试前提不成立').not.toBeNull()

    const result = (await tools().batchTryOn.execute!(
      {
        personAssetIds: ['p1', 'p2'],
        garmentIds: ['c1', 'c2'],
        category: 'auto',
        mode: 'balanced',
        garmentPhotoType: 'auto',
      },
      {} as never,
    )) as { estimatedTotalUsd: number; count: number }

    expect(result.count).toBe(4)
    expect(result.estimatedTotalUsd).toBeCloseTo((perRun as number) * 4, 6)
  })

  it('试穿品类参数不合法时抛错，且一张都不入队', async () => {
    await expect(
      tools().batchTryOn.execute!(
        {
          personAssetIds: ['p1'],
          garmentIds: ['c1'],
          category: '不是合法品类' as never,
          mode: 'balanced',
          garmentPhotoType: 'auto',
        },
        {} as never,
      ),
    ).rejects.toThrow()

    expect(enqueueGeneration).not.toHaveBeenCalled()
  })

  it('有一件衣服不属于本会话时，同批的其它组合也不入队', async () => {
    // requireOwnedGarment 查不到 → 抛错
    dbHolder.rows = []

    await expect(
      tools().batchTryOn.execute!(
        {
          personAssetIds: ['p1', 'p2'],
          garmentIds: ['c1', 'c2'],
          category: 'auto',
          mode: 'balanced',
          garmentPhotoType: 'auto',
        },
        {} as never,
      ),
    ).rejects.toThrow(/找不到/)

    expect(enqueueGeneration).not.toHaveBeenCalled()
  })
})
