import sharp from 'sharp'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createCropGarmentTool } from '@/lib/agent/tools'

/**
 * 守的是 cropGarment 的三件事，每一件失败时都不会报错，只会在别处体现：
 *
 *  1. **跳过的那件不能照样写库** —— 用户会在衣橱里看到一件他说不清来历的衣服
 *  2. **归属校验必须发生在调模型之前** —— 反过来的话，别人照片的分析费用由我们出
 *  3. **库里的宽高必须与真落盘的那张图一致** —— 不一致会让工作台网格的排版错位，
 *     而图片本身看起来是好的，没人会往数据库方向查
 */

const {
  dbHolder,
  insertCalls,
  storageGet,
  storagePut,
  storageUrl,
  generateObjectSpy,
} = vi.hoisted(() => ({
  dbHolder: { rows: [] as unknown[] },
  insertCalls: [] as { values: Record<string, unknown> }[],
  storageGet: vi.fn(async () => ({ body: Buffer.from(''), mime: 'image/png' })),
  storagePut: vi.fn(async (key: string, body: Buffer, options: { mime: string }) => ({
    key,
    mime: options.mime,
    bytes: body.byteLength,
  })),
  storageUrl: vi.fn((key: string) => `/api/files/${key}`),
  generateObjectSpy: vi.fn(async () => ({
    object: {
      items: [
        { title: '白色衬衫', color: '白色', box: { x: 0, y: 0, width: 1, height: 0.3 } },
        { title: '卡其色长裤', color: '卡其色', box: { x: 0, y: 0.6, width: 1, height: 0.4 } },
      ],
    },
  })),
}))

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => dbHolder.rows }) }),
    }),
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        insertCalls.push({ values })
      },
    }),
  },
}))

vi.mock('@/lib/agent/model', () => ({
  getAgentModel: () => ({}) as never,
  AGENT_MODEL_ID: 'mock-model',
}))

// 保留真的 buildStorageKey：这样 `crops/` 这个新命名空间是真的过了一遍校验，
// 而不是被 mock 掉之后看起来通过
vi.mock('@/lib/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storage')>()),
  storage: { get: storageGet, put: storagePut, url: storageUrl },
}))

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateObject: generateObjectSpy,
}))

/**
 * 会话 id 必须是 **UUID 形状**，不能像其它工具测试那样随手写 'sess-1'。
 *
 * 本工具会调 `buildStorageKey`，而它对 key 做的是白名单校验（两段路径都要求
 * 36 位 UUID），形状不对会当场抛错。生产环境里会话 id 就是 `crypto.randomUUID()`
 * 生成的（见 session.ts，实测库里的行也是 UUID），这里只是跟上它 ——
 * 顺带把「key 格式校验真的在生效」这件事也测进去了。
 */
const SESSION_ID = '11111111-1111-4111-8111-111111111111'

const OWNED_ASSET = {
  id: 'asset-1',
  sessionId: SESSION_ID,
  storageKey: `uploads/${SESSION_ID}/asset-1.webp`,
  width: 200,
  height: 400,
}

/*
 * 这个工具**不在 `createAgentTools` 的注册表里**（定位精度未达标，见 tools.ts 里
 * `createCropGarmentTool` 的说明），所以单测直接拿工厂。外面套一层 `cropGarment`
 * 是为了让下面所有断言与已注册时一字不差 —— 接回注册表时这里不用改。
 */
const tools = () => ({ cropGarment: createCropGarmentTool({ sessionId: SESSION_ID }) })

/** 一张上红下蓝的图：用来验"裁的确实是框住的那块" */
async function makeTwoTone(width: number, height: number) {
  const half = Math.floor(height / 2)
  const red = await sharp({
    create: { width, height: half, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer()
  const blue = await sharp({
    create: { width, height: height - half, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer()

  return sharp({ create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([
      { input: red, top: 0, left: 0 },
      { input: blue, top: half, left: 0 },
    ])
    .png()
    .toBuffer()
}

const SOURCE = await makeTwoTone(OWNED_ASSET.width, OWNED_ASSET.height)

afterAll(() => {
  // sharp 在这台机器上会留一个 worker，测试结束时释放掉，免得 vitest 报未清理句柄
  void sharp.cache(false)
})

beforeEach(() => {
  dbHolder.rows = [OWNED_ASSET]
  insertCalls.length = 0
  generateObjectSpy.mockClear()
  storageGet.mockClear()
  storagePut.mockClear()
  storageUrl.mockClear()
  storageGet.mockResolvedValue({ body: SOURCE, mime: 'image/png' })
})

/**
 * `execute` 的返回类型是「结果对象 | 流」的联合（ai@7 的 tool 允许流式返回），
 * 单测里要的是那一份结果对象。在这里收一次口 —— 与 inspect-photo 的做法一致。
 */
type CropResult = {
  created: { garmentId: string; title: string; color: string; imageUrl: string }[]
  skipped: { title: string; reason: string }[]
  detected: number
}

async function runCrop(assetId: string): Promise<CropResult> {
  return (await tools().cropGarment.execute!({ assetId }, {} as never)) as CropResult
}

describe('cropGarment：正常路径', () => {
  it('每件服装各落一张图、各登记一条衣橱记录', async () => {
    const result = await runCrop('asset-1')

    expect(result.detected).toBe(2)
    expect(result.skipped).toEqual([])
    expect(result.created.map((c) => c.title)).toEqual(['白色衬衫', '卡其色长裤'])
    expect(result.created.every((c) => c.imageUrl.startsWith('/api/files/crops/'))).toBe(true)

    const assetRows = insertCalls.filter((c) => 'storageKey' in c.values)
    const garmentRows = insertCalls.filter((c) => 'photoType' in c.values)
    expect(assetRows).toHaveLength(2)
    expect(garmentRows).toHaveLength(2)

    /*
     * 裁剪产物是 `derived` 而不是 `upload`。
     *
     * 这条不是命名洁癖：`listRecentPhotos` 按 `kind = 'upload'` 反推「我传过哪些图」，
     * 标错了用户会在自己的照片列表里看到一堆系统造出来的小图。
     */
    expect(assetRows.every((c) => c.values.kind === 'derived')).toBe(true)

    // 框是从真人照里量出来的，不是平铺拍摄 —— 这是本工具已经知道的事实
    expect(garmentRows.every((c) => c.values.photoType === 'model')).toBe(true)
  })

  it('衣橱记录指向的正是自己那张裁剪图，且库里的宽高与真落盘的那张一致', async () => {
    await runCrop('asset-1')

    const assetRows = insertCalls.filter((c) => 'storageKey' in c.values)
    const garmentRows = insertCalls.filter((c) => 'photoType' in c.values)

    for (const [index, assetRow] of assetRows.entries()) {
      // 指错资产的话，试穿会拿另一张图去换 —— 而界面上每张图单独看都没问题
      expect(garmentRows[index].values.assetId).toBe(assetRow.values.id)

      /*
       * 库里的宽高必须等于真落盘那张图的宽高。
       *
       * 不一致的后果是工作台网格排版错位（按错误的宽高比留位），
       * 而点开图片看又是好的 —— 那种错没人会往数据库方向查。
       */
      const stored = storagePut.mock.calls[index][1]
      const meta = await sharp(stored).metadata()
      expect({ width: meta.width, height: meta.height }).toEqual({
        width: assetRow.values.width,
        height: assetRow.values.height,
      })
    }
  })

  it('裁出来的确实是框住的那一块（下装取下半张图）', async () => {
    await runCrop('asset-1')

    // 第二件是 y=0.6 起算的下装，落盘的那张图左上角应当是蓝色
    const bottomCrop = storagePut.mock.calls[1][1]
    const { data } = await sharp(bottomCrop).raw().toBuffer({ resolveWithObject: true })
    expect(data[2]).toBeGreaterThan(200) // b
    expect(data[0]).toBeLessThan(60) // r
  })
})

describe('cropGarment：框不成形时', () => {
  it('跳过并如实报出来，且**不为它写任何一行库**', async () => {
    generateObjectSpy.mockResolvedValue({
      object: {
        items: [
          { title: '正常的衬衫', color: '白色', box: { x: 0, y: 0, width: 1, height: 0.3 } },
          // 0.05% 的框 —— 多半指向纽扣或腰带，不是一件衣服
          { title: '腰带', color: '棕色', box: { x: 0.5, y: 0.5, width: 0.0005, height: 0.0005 } },
        ],
      },
    } as never)

    const result = await runCrop('asset-1')

    expect(result.created).toHaveLength(1)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].title).toBe('腰带')

    /*
     * 关键在**数量**上：跳过的那件如果照样写库，用户会在衣橱里看到一件
     * 图是别的东西、名字对不上的衣服，而且没有任何线索指向"框没框好"。
     */
    expect(insertCalls.filter((c) => 'photoType' in c.values)).toHaveLength(1)
    expect(storagePut).toHaveBeenCalledTimes(1)
  })
})

describe('cropGarment：归属校验', () => {
  it('不是自己传的图直接抛错，且**一次模型调用都不发生**', async () => {
    dbHolder.rows = []

    await expect(
      tools().cropGarment.execute!({ assetId: '别人的图' }, {} as never),
    ).rejects.toThrow()

    /*
     * 这条是全部断言里最值钱的一条。
     *
     * 把归属校验放到调模型之后是很容易写出来的顺序，而它的失败形态是
     * **账单上的**：别人的照片被看了一遍，我们付钱，界面上一切正常。
     */
    expect(generateObjectSpy).not.toHaveBeenCalled()
    expect(storagePut).not.toHaveBeenCalled()
  })
})
