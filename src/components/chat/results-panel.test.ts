import { describe, expect, it } from 'vitest'

import { canCompare, garmentLabel, isActive } from '@/components/chat/results-panel'

/**
 * 结果区的两个判断，都对"界面看起来对不对"有直接影响，
 * 而错了之后**很难从屏幕上反推**：
 *
 *  - `isActive` 写错：要么无休止轮询，要么新图永远不自动出现。
 *  - `canCompare` 写错：把空串放进 `src`，浏览器会去**重新请求当前页面**，
 *    或者渲染成一张破图 —— 两种都被当成"图片加载慢"而没人查。
 */

describe('isActive：什么时候还该继续轮询', () => {
  it('queued 与 processing 算活跃', () => {
    expect(isActive('queued')).toBe(true)
    expect(isActive('processing')).toBe(true)
  })

  it('三个终态都不算活跃 —— 否则界面会永远轮询下去', () => {
    expect(isActive('succeeded')).toBe(false)
    expect(isActive('failed')).toBe(false)
    expect(isActive('canceled')).toBe(false)
  })
})

describe('canCompare：够不够渲染对比滑块', () => {
  it('两张图都在才渲染', () => {
    expect(canCompare({ imageUrl: '/a.png', personImageUrl: '/b.png' })).toBe(true)
  })

  it('缺任意一张都不渲染', () => {
    expect(canCompare({ imageUrl: null, personImageUrl: '/b.png' })).toBe(false)
    expect(canCompare({ imageUrl: '/a.png', personImageUrl: null })).toBe(false)
    expect(canCompare({ imageUrl: null, personImageUrl: null })).toBe(false)
  })

  it('空串也算缺 —— 它比 null 更糟，浏览器会把 src="" 当成重新请求当前页面', () => {
    expect(canCompare({ imageUrl: '', personImageUrl: '/b.png' })).toBe(false)
    expect(canCompare({ imageUrl: '/a.png', personImageUrl: '' })).toBe(false)
  })
})

describe('garmentLabel：卡片标题写什么', () => {
  it('有识别结果就写那件衣服是什么，而不是"换装"两个字', () => {
    // 用户回头翻结果时认得出"蓝色棒球外套"，认不出"换装"
    expect(garmentLabel({ taskKind: 'tryon', garmentTitle: '蓝色棒球外套' })).toBe(
      '蓝色棒球外套',
    )
  })

  it('识别结果缺失时退回任务类型，而不是渲染出 null 或空白', () => {
    expect(garmentLabel({ taskKind: 'tryon', garmentTitle: null })).toBe('换装')
    expect(garmentLabel({ taskKind: 'hair', garmentTitle: null })).toBe('换发型')
  })

  it('只有空白的标题也当缺失 —— 否则卡片上会出现一片说不清的空白', () => {
    expect(garmentLabel({ taskKind: 'tryon', garmentTitle: '   ' })).toBe('换装')
  })

  it('换发型任务永远不显示衣服描述，哪怕数据脏了带上 title', () => {
    // 在"换发型"的卡片上写一件外套的款式，会让用户以为换了件衣服
    expect(garmentLabel({ taskKind: 'hair', garmentTitle: '蓝色棒球外套' })).toBe(
      '换发型',
    )
  })
})
