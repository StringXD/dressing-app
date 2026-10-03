import { hasEnv } from '@/lib/env'

import type { ExtractContext, ExtractResult, Extractor } from './types'

/**
 * Tier C：整页截图 → 视觉模型选图。
 *
 * ── 为什么这里只有可用性判定，没有实现体 ────────────────────────
 *
 * 这一档需要两样当前都不具备的东西：
 *  1. **无头浏览器**（puppeteer / playwright）来给商品页截图。
 *     本项目当前没装，装它意味着几百 MB 依赖 + 一个常驻浏览器进程。
 *  2. **视觉模型 Key**（ANTHROPIC_API_KEY）。
 *
 * 与其写一段在具备条件前无法验证、也不会被执行的大块实现（那是最容易
 * 腐坏的一类代码），不如把"缺什么"明确暴露出来：
 * navigate/截图/选图的代码，等这两样真正到位时再写，届时它的正确性
 * 可以当场验证。
 *
 * ── 与 Tier D 的关系（重要）────────────────────────────────────
 *
 * Tier D 让**用户自己发商品截图**，然后由视觉模型从截图里识别服装。
 * 那条路不需要无头浏览器，对所有平台都成立，且国内用户本就习惯截图分享。
 * 因此 Tier C 并非不可或缺 —— 它只是"用户懒得截图时"的一点便利。
 * 这也是为什么本阶段可以坦然让它缺席，而把力气放在 Tier D 上。
 */
export function createVlmFallbackExtractor(): Extractor {
  return {
    tier: 'vlm',

    availability: () => {
      const missing: string[] = []

      if (!hasEnv('ANTHROPIC_API_KEY')) {
        missing.push('未配置 ANTHROPIC_API_KEY')
      }

      // 截图能力是代码层面的缺口，不是配置问题，所以单独表述
      missing.push('缺少无头浏览器截图能力（尚未接入 puppeteer/playwright）')

      return { available: false, reason: missing.join('；') }
    },

    async extract(_ctx: ExtractContext): Promise<ExtractResult> {
      // availability() 返回不可用时编排层会直接跳过，不会走到这里。
      // 保留明确的失败返回而不是 throw：解析链路上不允许有未捕获异常。
      return {
        ok: false,
        reason: 'Tier C 尚未实现（需要无头浏览器与视觉模型 Key，见本文件顶部说明）',
      }
    },
  }
}
