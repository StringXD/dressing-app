import { describe, expect, it } from 'vitest'

import {
  bodyShapeSchema,
  colorSeasonSchema,
  critiqueSchema,
} from '@/lib/generation/assessments'
import {
  bodyShapeLabel,
  buildCritiqueView,
  colorRatingLabel,
  colorSeasonLabel,
  fitLabel,
} from '@/lib/generation/assessment-labels'

/**
 * 守的是"上游英文枚举不上屏"。
 *
 * 映射表是手工维护的，所以**必然**会有"加了新枚举值、忘了加中文"的一天。
 * 下面那两条遍历断言就是为此存在的：取值集合直接从 Zod schema 里读，
 * 而不是在测试里再抄一份 —— 抄一份的话，新增取值时测试也跟着漏。
 */

describe('每个枚举值都有中文', () => {
  it('合身度与配色评分', () => {
    for (const value of critiqueSchema.shape.fit.shape.rating.options) {
      expect(fitLabel(value), `合身度缺中文：${value}`).not.toBe(value)
    }
    for (const value of critiqueSchema.shape.color.shape.rating.options) {
      expect(colorRatingLabel(value), `配色评分缺中文：${value}`).not.toBe(value)
    }
  })

  it('体型与色彩季型', () => {
    for (const value of bodyShapeSchema.shape.shape.options) {
      expect(bodyShapeLabel(value), `体型缺中文：${value}`).not.toBe(value)
    }
    for (const value of colorSeasonSchema.shape.season.options) {
      expect(colorSeasonLabel(value), `季型缺中文：${value}`).not.toBe(value)
    }
  })
})

describe('遇到没见过的取值时退回原值，而不是 undefined', () => {
  // 结论是模型产出的，换个模型或改一次提示词都可能冒出新取值。
  // 那时界面上出现英文单词，比出现空白或 "undefined" 好查得多。
  it('未知枚举值原样返回', () => {
    expect(fitLabel('some-new-rating')).toBe('some-new-rating')
    expect(colorSeasonLabel('monsoon')).toBe('monsoon')
  })

  it('null / undefined / 空串都给空串，不渲染出 "null" 这种字样', () => {
    expect(fitLabel(null)).toBe('')
    expect(fitLabel(undefined)).toBe('')
    expect(fitLabel('')).toBe('')
    expect(colorRatingLabel(42)).toBe('')
  })
})

describe('buildCritiqueView：把已存的评价转成界面上那几行', () => {
  const PAYLOAD = {
    fit: { rating: 'good', notes: '肩线正落在肩头' },
    color: { rating: 'excellent', notes: '米白压住了肤色' },
    highlights: ['腰线位置好'],
    suggestions: ['袖长改短两公分'],
  }

  it('评分翻成中文，并带上判断依据', () => {
    const view = buildCritiqueView(PAYLOAD)

    // 少了 label 这一步，界面上就是 "good · 肩线正落在肩头" —— 正是"英文枚举不上屏"要拦的
    expect(view?.fit).toBe('合身 · 肩线正落在肩头')
    expect(view?.color).toBe('配色出色 · 米白压住了肤色')
    expect(view?.highlights).toEqual(['腰线位置好'])
    expect(view?.suggestions).toEqual(['袖长改短两公分'])
  })

  it('缺一项就少一行，不是给一个"暂无"', () => {
    const view = buildCritiqueView({ ...PAYLOAD, color: undefined })

    expect(view?.fit).toBe('合身 · 肩线正落在肩头')
    expect(view?.color).toBeNull()
    // 有内容的项仍然要出来 —— 只断言 color 为 null 的话，
    // 一个"永远返回 null"的实现也能通过
    expect(view?.highlights).toHaveLength(1)
  })

  it('整份 payload 没有任何可显示内容时返回 null，让卡片整块不渲染', () => {
    expect(buildCritiqueView({})).toBeNull()
    expect(buildCritiqueView({ fit: {}, color: {}, highlights: [], suggestions: [] })).toBeNull()
  })

  it('payload 根本不是对象时不抛错 —— 它来自 jsonb，形状不受类型系统保护', () => {
    expect(buildCritiqueView(null)).toBeNull()
    expect(buildCritiqueView(undefined)).toBeNull()
    expect(buildCritiqueView('一段字符串')).toBeNull()
    expect(buildCritiqueView(42)).toBeNull()
  })

  it('notes 不是字符串、数组里混了非字符串时，只丢掉坏的项', () => {
    const view = buildCritiqueView({
      fit: { rating: 'loose', notes: { 这不是字符串: true } },
      highlights: ['好的', 42, null, '也是好的'],
    })

    expect(view?.fit).toBe('偏松')
    expect(view?.highlights).toEqual(['好的', '也是好的'])
  })

  it('没见过的评分原样显示，而不是消失', () => {
    const view = buildCritiqueView({ fit: { rating: 'slightly-snug', notes: '新模型给的取值' } })

    expect(view?.fit).toBe('slightly-snug · 新模型给的取值')
  })
})
