import type { PhotoCheck } from '@/lib/generation/assessments'

/**
 * 输入质量预检。
 *
 * ── 为什么这件事值得做 ────────────────────────────────────────
 * 图片在归一化时**只缩不放**（`normalize.ts` 的 `withoutEnlargement: true`），
 * 而 FASHN 的输出分辨率**等于输入分辨率**（实测：270×360 进、270×360 出）。
 * 两条合起来意味着：用户传一张 270×360 的小图，付 $0.075，拿回一张 270×360 ——
 * 钱花了，成品在手机上都糊。这是**真实的浪费**，而且完全可以在提交之前看出来。
 *
 * ── 为什么分成两层 ──────────────────────────────────────────
 * **几何检查是免费的、确定的**，只要有宽高就能做，所以它跑在最前面，
 * 甚至不需要调用任何模型。**内容检查要调视觉模型**（"图里有没有人""是不是全身"），
 * 只在几何检查过了之后才值得花那点 token。
 *
 * ── 阈值从哪来 ──────────────────────────────────────────────
 * 只有一个依据可用：输出等于输入。所以阈值是在回答"多大的成品才不算白花钱"，
 * 而不是在猜上游的限制。下面两个常数是**产品判断**，不是上游约束 ——
 * 写清楚这一点，是为了让后来的人知道可以改，而不必去找"上游文档里的那个数"
 * （并不存在）。
 */

/** 低于它就该提醒：成品在大屏上会明显发虚 */
export const SHORT_SIDE_SOFT = 768

/** 低于它成品基本没有使用价值，属于明确该拦下来的那一档 */
export const SHORT_SIDE_POOR = 512

export type QualityLevel = 'ok' | 'warning' | 'poor'

/**
 * 机器可读的原因，便于将来做聚合统计（"用户最常踩的是哪一类"）。
 *
 * 别把它当成给人看的标签 —— 给用户看的是 `message`，两者分开是为了
 * 改文案时不会连带改掉统计口径。
 */
export type QualityIssueCode =
  | 'low-resolution'
  | 'no-person'
  | 'not-full-body'
  | 'blurry'

export interface QualityIssue {
  code: QualityIssueCode
  /** 直接给用户看的中文，必须包含"该怎么办" */
  message: string
}

export interface QualityReport {
  level: QualityLevel
  issues: QualityIssue[]
}

/**
 * 几何检查。纯函数，不碰 db、不调模型。
 *
 * 宽高都是可空的：`assets.width` / `height` 在库里允许为空（历史数据、
 * 或将来别的写入方）。**缺失时不猜、也不报错**，直接给 ok ——
 * 拿不到尺寸就断言"这张图太小"，会把一个未知当成一个已知。
 */
export function inspectImageQuality(dims: {
  width: number | null
  height: number | null
}): QualityReport {
  const { width, height } = dims
  if (typeof width !== 'number' || typeof height !== 'number') {
    return { level: 'ok', issues: [] }
  }

  const shortSide = Math.min(width, height)
  if (shortSide <= 0) return { level: 'ok', issues: [] }

  if (shortSide < SHORT_SIDE_POOR) {
    return {
      level: 'poor',
      issues: [
        {
          code: 'low-resolution',
          message:
            `这张图只有 ${width}×${height}，太小了。` +
            `生成结果会和它一样大，花同样的钱拿回一张糊图。` +
            `建议换一张长边至少 ${SHORT_SIDE_SOFT} 像素的照片。`,
        },
      ],
    }
  }

  if (shortSide < SHORT_SIDE_SOFT) {
    return {
      level: 'warning',
      issues: [
        {
          code: 'low-resolution',
          message:
            `这张图是 ${width}×${height}，生成结果会和它一样大，` +
            `放大看会发虚。有更大原图的话建议换一张。`,
        },
      ],
    }
  }

  return { level: 'ok', issues: [] }
}

/**
 * 把几何结论与视觉模型的结论合成一个可展示的判断。
 *
 * 分成两层而不是"都交给模型"：几何部分**永远是对的**，不该因为一次
 * 视觉判断的偏差而被稀释；而视觉部分能看见几何看不见的东西（图里有没有人）。
 *
 * `check` 为 null 表示还没做过内容检查 —— 那时**只报几何结论**，
 * 不假装知道更多。
 */
export function buildPhotoReport(
  dims: { width: number | null; height: number | null },
  check: PhotoCheck | null,
): QualityReport & { advice: string[] } {
  const geometry = inspectImageQuality(dims)
  const issues = [...geometry.issues]
  const advice: string[] = []
  let level = geometry.level

  if (check) {
    /*
     * 图里没有人 —— 这条是**最该在提交之前拦下来**的：
     * FASHN 会对人物图跑姿态检测，非真人照片直接 422
     * （`Failed to detect body pose in model image`）。
     * 这一步省下的是一整轮注定失败的等待。
     */
    if (!check.hasPerson || check.framing === 'unclear') {
      level = 'poor'
      issues.push({
        code: 'no-person',
        message: '这张图里看不出有一个人，换装模型在它上面找不到人体，会直接失败。请换一张人像照片。',
      })
    } else if (check.framing !== 'full-body') {
      if (level !== 'poor') level = 'warning'
      issues.push({
        code: 'not-full-body',
        message:
          check.framing === 'headshot'
            ? '这是一张头部特写。换装需要看到全身，这张很可能直接失败。'
            : '这看起来是半身照。换装模型对人物图做姿态检测，半身照经常失败 —— 建议换一张能看到全身的。',
      })
    }

    if (check.clarity === 'blurry') {
      if (level === 'ok') level = 'warning'
      issues.push({
        code: 'blurry',
        message: '这张图比较模糊，生成的细节也会跟着糊。',
      })
    }

    advice.push(...check.advice)
  }

  return { level, issues, advice }
}

/** 检查结论来自缓存时，界面与模型都要如实说明，理由同其它分析工具 */
export interface PhotoReportResult extends QualityReport {
  advice: string[]
  /** 视觉部分的结论；几何检查总是即时算的，所以这里为 null 表示没做内容检查 */
  check: PhotoCheck | null
  fromCache: boolean
  analyzedAt: Date | null
}
