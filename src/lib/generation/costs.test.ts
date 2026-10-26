import { describe, expect, it } from 'vitest'

import { buildCostSummary, type CostRow } from '@/lib/generation/costs'
import { explainGenerationError } from '@/lib/generation/errors'

/**
 * 守的是**这个数字到底对不对得上账**。
 *
 * `generations.costUsd` 只在成功时写入，所以"把这一列加起来"这个最自然的实现
 * 会漏掉一整类**花了钱却没拿到图**的情况。漏掉的后果不是数字偏小而已：
 * 用户拿它去对 fal 的账单，对不上，然后这个看板就再也没人看了。
 *
 * 所以下面每一条断言都在回答同一个问题："这笔钱到底算进去了没有"，
 * 而三个桶（确实花了 / 不确定 / 没花）**互不重叠**是这套逻辑的核心。
 */

const SINCE = new Date('2026-09-04T00:00:00Z')

const row = (overrides: Partial<CostRow> = {}): CostRow => ({
  modelId: 'fal/fashn-tryon-1.6',
  taskKind: 'tryon',
  status: 'succeeded',
  costUsd: 0.075,
  errorCode: null,
  errorMessage: null,
  ...overrides,
})

/** 大多数测试用同一张价目表 */
const price = (modelId: string) =>
  modelId === 'fal/fashn-tryon-1.6' ? 0.075 : modelId === 'fal/apps-v2-tryon' ? 0.04 : null

describe('测试前提：下面用到的错误码分类没有变', () => {
  /*
   * 这一组的断言全部依赖 `explainGenerationError` 的分类。它变了而测试没跟上时，
   * 下面那些用例会以"数字对不上"的形式失败 —— 那会让人以为是成本逻辑坏了，
   * 跑去改一个本来正确的函数。所以前提先单独钉住，失败时直接指向真正的原因。
   */
  it('output_download_failed 是"已计费"', () => {
    expect(explainGenerationError('output_download_failed', null)?.cost).toBe('charged')
  })

  it('result_request_failed 是"不确定"', () => {
    expect(explainGenerationError('result_request_failed', null)?.cost).toBe('unknown')
  })

  it('姿态检测失败的 422 是"未计费"', () => {
    expect(
      explainGenerationError('http_422', 'body.person_image: Failed to detect body pose')?.cost,
    ).toBe('none')
  })
})

describe('成功的调用', () => {
  it('用行上记着的实际成本', () => {
    const summary = buildCostSummary([row()], price, SINCE)

    expect(summary.chargedUsd).toBeCloseTo(0.075, 6)
    expect(summary.succeededCount).toBe(1)
    expect(summary.chargedFailureCount).toBe(0)
    expect(summary.uncertainCount).toBe(0)
  })

  it('行上没有成本时回退到注册表的价格，而不是当作 0', () => {
    const summary = buildCostSummary([row({ costUsd: null })], price, SINCE)

    expect(summary.chargedUsd).toBeCloseTo(0.075, 6)
    expect(summary.succeededCount).toBe(1)
  })

  it('连价格都查不到时归入"不确定"，**不是 0**', () => {
    /*
     * 把查不到价格当成 0，会在看板上宣称"这次没花钱" —— 而事实是不知道。
     * 用户据此决定要不要再试一次，而那是要花钱的决定。
     */
    const summary = buildCostSummary(
      [row({ modelId: 'fal/已经下架的模型', costUsd: null })],
      price,
      SINCE,
    )

    expect(summary.chargedUsd).toBe(0)
    expect(summary.succeededCount).toBe(0)
    expect(summary.uncertainCount).toBe(1)
  })
})

describe('失败的调用：这才是最容易漏掉的那部分钱', () => {
  it('上游已计费的失败要算进去，并按注册表价格计', () => {
    const summary = buildCostSummary(
      [row({ status: 'failed', costUsd: null, errorCode: 'output_download_failed' })],
      price,
      SINCE,
    )

    // 这一条就是"只 sum(cost_usd)"会漏掉的那笔
    expect(summary.chargedUsd).toBeCloseTo(0.075, 6)
    expect(summary.chargedFailureCount).toBe(1)
    expect(summary.succeededCount).toBe(0)
  })

  it('确定没计费的失败一分钱都不加', () => {
    const summary = buildCostSummary(
      [row({ status: 'failed', costUsd: null, errorCode: 'http_422', errorMessage: 'body pose' })],
      price,
      SINCE,
    )

    expect(summary.chargedUsd).toBe(0)
    expect(summary.chargedFailureCount).toBe(0)
    expect(summary.uncertainCount).toBe(0)
  })

  it('不确定的失败单独计数，**绝不并进总额**', () => {
    const summary = buildCostSummary(
      [row({ status: 'failed', costUsd: null, errorCode: 'result_request_failed' })],
      price,
      SINCE,
    )

    /*
     * 把 unknown 按价格估一个数进去，这个看板从此就不可信了 ——
     * 而它唯一的用途就是可信。
     */
    expect(summary.chargedUsd).toBe(0)
    expect(summary.chargedFailureCount).toBe(0)
    expect(summary.uncertainCount).toBe(1)
  })

  it('已计费但模型已下架 → 归入不确定，不按 0 记账', () => {
    const summary = buildCostSummary(
      [
        row({
          status: 'failed',
          costUsd: null,
          modelId: 'fal/已经下架的模型',
          errorCode: 'output_download_failed',
        }),
      ],
      price,
      SINCE,
    )

    expect(summary.chargedUsd).toBe(0)
    expect(summary.chargedFailureCount).toBe(0)
    expect(summary.uncertainCount).toBe(1)
  })

  it('没有错误码的失败什么也不加（没有可解释的失败）', () => {
    const summary = buildCostSummary(
      [row({ status: 'failed', costUsd: null, errorCode: null })],
      price,
      SINCE,
    )

    expect(summary.chargedUsd).toBe(0)
    expect(summary.uncertainCount).toBe(0)
  })
})

describe('还没结束的任务不算钱', () => {
  it.each(['queued', 'processing'] as const)('%s 不计入', (status) => {
    const summary = buildCostSummary([row({ status, costUsd: null })], price, SINCE)

    expect(summary.chargedUsd).toBe(0)
    expect(summary.succeededCount).toBe(0)
    expect(summary.uncertainCount).toBe(0)
  })

  it('已取消的不计入 —— 取消发生在提交之前', () => {
    const summary = buildCostSummary([row({ status: 'canceled', costUsd: null })], price, SINCE)

    expect(summary.chargedUsd).toBe(0)
    expect(summary.uncertainCount).toBe(0)
  })
})

describe('总额与分组', () => {
  const rows: CostRow[] = [
    row(),
    row(),
    row({ status: 'failed', costUsd: null, errorCode: 'output_download_failed' }),
    row({ modelId: 'fal/apps-v2-tryon', costUsd: 0.04 }),
    row({ status: 'failed', costUsd: null, errorCode: 'result_request_failed' }),
  ]

  it('三类互不重叠，加起来就是总额', () => {
    const summary = buildCostSummary(rows, price, SINCE)

    // 0.075×3（两次成功 + 一次已计费失败）+ 0.04
    expect(summary.chargedUsd).toBeCloseTo(0.265, 6)
    expect(summary.succeededCount).toBe(3)
    expect(summary.chargedFailureCount).toBe(1)
    expect(summary.uncertainCount).toBe(1)
  })

  it('按模型分组，花费高的在前', () => {
    const summary = buildCostSummary(rows, price, SINCE)

    expect(summary.byModel.map((m) => m.modelId)).toEqual([
      'fal/fashn-tryon-1.6',
      'fal/apps-v2-tryon',
    ])
    expect(summary.byModel[0].chargedUsd).toBeCloseTo(0.225, 6)
    expect(summary.byModel[0].succeeded).toBe(2)
    expect(summary.byModel[0].chargedFailures).toBe(1)
  })

  it('带上注册表里的中文名，便于直接说给用户听', () => {
    const summary = buildCostSummary([row()], price, SINCE)

    expect(summary.byModel[0].label).toBe('FASHN 试穿 v1.6')
  })

  it('时间起点原样带出去 —— "共 $5" 与 "近 30 天 $5" 是两句话', () => {
    expect(buildCostSummary([], price, SINCE).since).toEqual(SINCE)
  })

  it('空输入给全零，不抛错', () => {
    const summary = buildCostSummary([], price, SINCE)

    expect(summary).toMatchObject({
      chargedUsd: 0,
      succeededCount: 0,
      chargedFailureCount: 0,
      uncertainCount: 0,
      byModel: [],
    })
  })
})
