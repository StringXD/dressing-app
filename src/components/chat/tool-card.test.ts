import { describe, expect, it } from 'vitest'

import { batchTryOnDetail, countBatchPairs } from '@/components/chat/tool-card'

/**
 * 守的是**审批卡片上那个数字**。
 *
 * 用户批准的应该是一个能自己核对的数字，而不是一句"会花钱"：
 * 8 张 $0.600 与 1 张 $0.075 若在界面上长得一样，"确认生成"这个按钮
 * 就退化成了盲签。这个数字里最容易错的是那个乘法 ——
 * 写成某一个数组的长度时，卡片显示的一切都完全正常。
 */

describe('countBatchPairs：人物 × 衣服', () => {
  it('是乘法，不是其中一个数组的长度', () => {
    expect(countBatchPairs({ personAssetIds: ['p1', 'p2'], garmentIds: ['c1', 'c2', 'c3'] })).toBe(6)
  })

  it('按去重后的数量算 —— 与服务端口径一致', () => {
    /*
     * 模型传 ['a','a','a'] 时真实只会生成一组。
     * 卡片若按入参长度显示 3 张，用户批准的数字就与实际扣费不符 ——
     * 那是这张卡片最不该犯的错。
     */
    expect(countBatchPairs({ personAssetIds: ['p1', 'p1', 'p1'], garmentIds: ['c1'] })).toBe(1)
    expect(countBatchPairs({ personAssetIds: ['p1', 'p1'], garmentIds: ['c1', 'c1'] })).toBe(1)
  })

  it('参数缺失或不是数组时返回 null，而不是 0', () => {
    // 0 张是一个"看起来很确定"的错误数字；null 让卡片退回只显示工具名
    expect(countBatchPairs({})).toBeNull()
    expect(countBatchPairs({ personAssetIds: ['p1'] })).toBeNull()
    expect(countBatchPairs({ personAssetIds: 'p1', garmentIds: ['c1'] })).toBeNull()
    expect(countBatchPairs({ personAssetIds: [], garmentIds: ['c1'] })).toBeNull()
  })
})

describe('batchTryOnDetail：审批前就要写出张数与总额', () => {
  it('同时写出张数与预估总额', () => {
    const detail = batchTryOnDetail(
      { personAssetIds: ['p1', 'p2'], garmentIds: ['c1', 'c2'] },
      0.075,
    )

    expect(detail).toContain('4 张')
    expect(detail).toContain('$0.300')
  })

  it('拿不到单张价格时仍然写出张数', () => {
    const detail = batchTryOnDetail({ personAssetIds: ['p1'], garmentIds: ['c1'] }, null)

    expect(detail).toContain('1 张')
    // 价格未知时不能编一个数字出来
    expect(detail).not.toContain('$')
  })

  it('默认档位与 auto 品类不占地方，非默认值才显示', () => {
    expect(
      batchTryOnDetail(
        { personAssetIds: ['p1'], garmentIds: ['c1'], category: 'auto', mode: 'balanced' },
        0.075,
      ),
    ).toBe('1 张 · 预计 $0.075')

    const custom = batchTryOnDetail(
      { personAssetIds: ['p1'], garmentIds: ['c1'], category: 'dress', mode: 'quality' },
      0.075,
    )

    expect(custom).toContain('dress')
    expect(custom).toContain('quality')
  })

  it('参数不成形时返回 null，让卡片退回只显示工具名', () => {
    expect(batchTryOnDetail({}, 0.075)).toBeNull()
  })
})
