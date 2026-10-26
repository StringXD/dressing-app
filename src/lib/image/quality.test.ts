import { describe, expect, it } from 'vitest'

import type { PhotoCheck } from '@/lib/generation/assessments'
import {
  SHORT_SIDE_POOR,
  SHORT_SIDE_SOFT,
  buildPhotoReport,
  inspectImageQuality,
} from '@/lib/image/quality'

/**
 * 守的是**在花钱之前把话说到**。
 *
 * 这一层的每个判断都直接对应一笔 $0.075 的支出，而失败的形态很安静：
 * 图片照样提交、照样计费、照样出一张图 —— 只是那张图糊得没法用。
 * 所以下面既有"该报的时候报了"，也有"**不该报的时候别报**"：
 * 一个总在报警的检查会训练用户忽略它，那等于没有检查。
 */

const check = (overrides: Partial<PhotoCheck> = {}): PhotoCheck => ({
  hasPerson: true,
  framing: 'full-body',
  clarity: 'sharp',
  notes: '全身入镜，肩线清晰',
  advice: [],
  ...overrides,
})

describe('几何检查：输出等于输入，所以尺寸直接决定成品', () => {
  it('大图不报任何问题', () => {
    expect(inspectImageQuality({ width: 1200, height: 1600 })).toEqual({
      level: 'ok',
      issues: [],
    })
  })

  it('小图给 poor，并且说明"钱会白花"而不只是"图小"', () => {
    const report = inspectImageQuality({ width: 270, height: 360 })

    expect(report.level).toBe('poor')
    expect(report.issues[0].code).toBe('low-resolution')
    // 文案要让人知道后果与怎么办，否则用户只会看到一句"图太小了"然后照旧提交
    expect(report.issues[0].message).toContain('270×360')
    expect(report.issues[0].message).toContain('糊')
    expect(report.issues[0].message).toContain(`${SHORT_SIDE_SOFT}`)
  })

  it('中间档给 warning 而不是 poor —— 凑合能用和不能用是两回事', () => {
    const report = inspectImageQuality({ width: SHORT_SIDE_SOFT, height: 1200 })

    // 恰好等于阈值算 ok：边界上宁可放过，不要为一个像素的事拦人
    expect(report.level).toBe('ok')

    expect(inspectImageQuality({ width: SHORT_SIDE_SOFT - 1, height: 1200 }).level).toBe(
      'warning',
    )
    expect(inspectImageQuality({ width: SHORT_SIDE_POOR, height: 1200 }).level).toBe('warning')
    expect(inspectImageQuality({ width: SHORT_SIDE_POOR - 1, height: 1200 }).level).toBe('poor')
  })

  it('看的是短边，不是长边 —— 细长条不是"大图"', () => {
    // 长边 4000 很唬人，但短边只有 300，输出同样不可用
    expect(inspectImageQuality({ width: 4000, height: 300 }).level).toBe('poor')
  })

  it('尺寸缺失时说 ok，不猜', () => {
    /*
     * `assets.width` / `height` 在库里允许为空。拿不到就说"这张图太小"
     * 是把一个未知当成一个已知 —— 而这个错误会让用户白白换掉一张好照片。
     */
    expect(inspectImageQuality({ width: null, height: null }).level).toBe('ok')
    expect(inspectImageQuality({ width: 1200, height: null }).level).toBe('ok')
    expect(inspectImageQuality({ width: 0, height: 0 }).level).toBe('ok')
  })
})

describe('内容检查：几何看不见的那些问题', () => {
  it('没有内容检查时只报几何结论，不假装知道更多', () => {
    const report = buildPhotoReport({ width: 1200, height: 1600 }, null)

    expect(report.level).toBe('ok')
    expect(report.issues).toEqual([])
  })

  it('图里没有人 → poor，且指名会失败', () => {
    const report = buildPhotoReport(
      { width: 1200, height: 1600 },
      check({ hasPerson: false }),
    )

    expect(report.level).toBe('poor')
    expect(report.issues.map((i) => i.code)).toContain('no-person')
    expect(report.issues[0].message).toContain('失败')
  })

  it('半身照 → warning，并说明原因（姿态检测）', () => {
    const report = buildPhotoReport(
      { width: 1200, height: 1600 },
      check({ framing: 'half-body' }),
    )

    expect(report.level).toBe('warning')
    expect(report.issues.map((i) => i.code)).toContain('not-full-body')
  })

  it('头部特写也归到取景问题，而不是被当成半身照', () => {
    const report = buildPhotoReport({ width: 1200, height: 1600 }, check({ framing: 'headshot' }))

    expect(report.issues.map((i) => i.code)).toContain('not-full-body')
    expect(report.issues[0].message).toContain('头部特写')
  })

  it('全身照但很糊 → warning', () => {
    const report = buildPhotoReport({ width: 1200, height: 1600 }, check({ clarity: 'blurry' }))

    expect(report.level).toBe('warning')
    expect(report.issues.map((i) => i.code)).toContain('blurry')
  })

  it('几何与内容的问题**都要报**，不是前者盖掉后者', () => {
    /*
     * 只报一条是最省事的实现，也是最误导的：用户按提示换了一张尺寸够大
     * 但仍然是半身照的图，回来还是一样的失败。
     */
    const report = buildPhotoReport(
      { width: 300, height: 400 },
      check({ framing: 'half-body', clarity: 'blurry' }),
    )

    expect(report.level).toBe('poor')
    expect(report.issues.map((i) => i.code)).toEqual([
      'low-resolution',
      'not-full-body',
      'blurry',
    ])
  })

  it('一切正常时不产出一条"没问题"的废话', () => {
    const report = buildPhotoReport({ width: 1200, height: 1600 }, check())

    expect(report.level).toBe('ok')
    expect(report.issues).toEqual([])
  })

  it('模型给的建议原样带出去', () => {
    const report = buildPhotoReport(
      { width: 1200, height: 1600 },
      check({ advice: ['把脚也拍进去'] }),
    )

    expect(report.advice).toEqual(['把脚也拍进去'])
  })
})
