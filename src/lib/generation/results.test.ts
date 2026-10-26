import { describe, expect, it } from 'vitest'

import { buildResultViews, type ResultRow } from '@/lib/generation/results'

/**
 * 这一组守两件事，其中第一件涉及**别人的图片会不会被看到**。
 *
 * `buildResultViews` 是纯函数（不碰 db，只做一次 Map 查找），所以归属过滤
 * 这件事可以在这里被直接钉住 —— 而它一旦失效，后果是任何一个会话都能
 * 看到别人的生成结果。
 *
 * 背景：调用方 `listRecentResults` 会带 `eq(sessionId)` 去查资产，
 * 不属于本会话的资产压根不会出现在 `keyByAssetId` 里。所以这里的断言
 * 就是那条 SQL 约束的**前端体现**：查不到 key 时必须是 null。
 */

const row = (overrides: Partial<ResultRow> = {}): ResultRow => ({
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
  ...overrides,
})

const KEYS = new Map([
  ['out-1', 'generated/s1/out.png'],
  ['person-1', 'uploads/s1/person.webp'],
])

describe('buildResultViews', () => {
  it('产物图与原图都解析成可访问的地址，其余字段原样透传', () => {
    const [view] = buildResultViews([row()], KEYS)

    expect(view.imageUrl).toBe('/api/files/generated/s1/out.png')
    expect(view.personImageUrl).toBe('/api/files/uploads/s1/person.webp')
    expect(view).toMatchObject({
      generationId: 'gen-1',
      taskKind: 'tryon',
      modelId: 'fal/apps-v2-tryon',
      status: 'succeeded',
      costUsd: 0.04,
      garmentId: 'garment-1',
    })
  })

  it('归属过滤：Map 里查不到的资产必须给 null，绝不凭 id 拼出一个地址', () => {
    // 模拟"这个资产不属于本会话，被 SQL 的 eq(sessionId) 滤掉了"
    const [view] = buildResultViews(
      [row({ outputAssetId: 'someone-elses-output', personAssetId: 'someone-elses-person' })],
      KEYS,
    )

    expect(view.imageUrl).toBeNull()
    expect(view.personImageUrl).toBeNull()

    // 这条才是真正的守卫：把 `urlFor` 改成 `storage.url(assetId)` 这类
    // "反正拼个地址出来"的写法时，上面两条仍然过得去（只要返回非 null 就红了，
    // 但万一有人把断言放宽成 toBeTruthy 呢）。这里明确要求它**不含那个 id**。
    expect(JSON.stringify(view)).not.toContain('someone-elses')
  })

  it('还没产出（outputAssetId 为 null）时 imageUrl 是 null，而不是空串', () => {
    // 空串在浏览器里会被 `src=""` 当成"请求当前页面"，比没有图更糟
    const [view] = buildResultViews([row({ outputAssetId: null, status: 'failed' })], KEYS)

    expect(view.imageUrl).toBeNull()
    // 原图还在，所以对比滑块的 before 侧仍然可用
    expect(view.personImageUrl).toBe('/api/files/uploads/s1/person.webp')
  })

  it('换发型这类没有衣服的任务，garmentId 如实为 null', () => {
    const [view] = buildResultViews(
      [row({ taskKind: 'hair', garmentId: null, garmentTitle: null, garmentColor: null })],
      KEYS,
    )

    expect(view.garmentId).toBeNull()
    expect(view.garmentTitle).toBeNull()
    expect(view.garmentColor).toBeNull()
    expect(view.taskKind).toBe('hair')
  })

  it('衣服的款式与颜色必须透传 —— 模型就是靠这两列回答"上次那件怎么样"', () => {
    // 事故背景：这两列原本没有被查出来，模型手里只有一串 garmentId，
    // 于是只能回答"记录里只有 id"，用户根本没法判断那是什么衣服。
    const [view] = buildResultViews([row()], KEYS)

    expect(view.garmentTitle).toBe('黑色燕尾服外套')
    expect(view.garmentColor).toBe('黑色')
    // 只透传 id 是不够的：id 对用户没有任何意义
    expect(view.garmentId).toBe('garment-1')
  })

  it('衣服记录已被删除（leftJoin 落空）时两列为 null，而不是 undefined', () => {
    // undefined 会在 JSON 里整个消失，模型看到的是一个"没有这个字段"的对象，
    // 与"有字段但为空"是不同的信号 —— 后者它才会说"看不到描述"。
    const [view] = buildResultViews(
      [row({ garmentTitle: null, garmentColor: null })],
      KEYS,
    )

    expect(view.garmentTitle).toBeNull()
    expect(view.garmentColor).toBeNull()
    expect(Object.keys(view)).toContain('garmentTitle')
  })

  it('空输入给空数组，不抛错', () => {
    expect(buildResultViews([], KEYS)).toEqual([])
  })
})
