import { describe, expect, it } from 'vitest'

import { waitedNote } from './progress-notice'

/**
 * 守的是"等了多久"这句话的**边界**，不是它的格式。
 *
 * 它出现在队列面板上，而面板是刷新页面的人唯一能看到的进度信息 ——
 * 说错比不说更糟：显示"已等 -3 秒"会让人以为界面坏了，
 * 显示一个不存在的等待时长会让人以为任务卡住了。
 *
 * `now` 由调用方注入，测试才能钉住时间点。直接读 `Date.now()` 的话，
 * 边界断言（59 秒 / 60 秒）会随机通过或失败。
 */

const T0 = Date.parse('2026-10-04T04:00:00Z')

describe('waitedNote', () => {
  it('没有入队时刻就不说 —— 按 id 查的那种形态本来就不带它', () => {
    expect(waitedNote(undefined, T0)).toBe('')
  })

  it('时间戳解析不出来时不说，而不是显示 NaN', () => {
    expect(waitedNote('不是时间', T0)).toBe('')
  })

  it('未来时间戳不显示负数 —— 时钟漂移时宁可不说', () => {
    expect(waitedNote('2026-10-04T04:00:30Z', T0)).toBe('')
  })

  it('秒、分、时三档的边界', () => {
    expect(waitedNote('2026-10-04T03:59:15Z', T0)).toBe(' · 已等 45 秒')
    // 59 秒还是"秒"，60 秒才进位到"分"
    expect(waitedNote('2026-10-04T03:59:01Z', T0)).toBe(' · 已等 59 秒')
    expect(waitedNote('2026-10-04T03:59:00Z', T0)).toBe(' · 已等 1 分钟')
    // 59 分钟还是"分"，60 分钟才进位到"小时"
    expect(waitedNote('2026-10-04T03:01:00Z', T0)).toBe(' · 已等 59 分钟')
    expect(waitedNote('2026-10-04T03:00:00Z', T0)).toBe(' · 已等 1 小时')
  })

  it('等待时长为零时也要给出一句话，而不是空串', () => {
    // 空串意味着"没有信息"，而"刚入队"是有信息的 —— 它是 0 秒，不是未知
    expect(waitedNote('2026-10-04T04:00:00Z', T0)).toBe(' · 已等 0 秒')
  })
})
