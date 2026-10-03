import type { ModelSpec } from './types'

/**
 * 模型注册表。
 *
 * **纯数据** —— 新增端点、调整价格、切换降级档位都只改这里，不触碰编排、API 与前端。
 *
 * 所有条目都已逐个核对过 fal 官方 schema 与价格（见各条 comment），
 * `license` 一律为 commercial：调研已确认 OOTDiffusion / CatVTON 等主流换装方案
 * 是 CC BY-NC-SA 4.0（禁商用），本项目定位未定，因此从源头只选可商用的。
 *
 * ⚠️ 刻意不收录 `fal-ai/cat-vton`：该端点 licenseType 为 research（非商用）。
 * 它的效果不差，但一旦产品化就是法律风险。
 */
export const MODELS: readonly ModelSpec[] = [
  // ── 换装 ─────────────────────────────────────────────────────
  {
    id: 'fal/fashn-tryon-1.6',
    providerId: 'fal',
    endpoint: 'fal-ai/fashn/tryon/v1.6',
    kind: 'tryon',
    label: 'FASHN 试穿 v1.6',
    // 官方 llms.txt 标价 $0.075/generation
    costUsdPerRun: 0.075,
    license: 'commercial',
    tier: 'premium',
  },
  {
    id: 'fal/apps-v2-tryon',
    providerId: 'fal',
    endpoint: 'fal-ai/image-apps-v2/virtual-try-on',
    kind: 'tryon',
    label: '通用试穿（经济档）',
    // 官方 llms.txt 标价 $0.04/image
    costUsdPerRun: 0.04,
    license: 'commercial',
    tier: 'budget',
  },

  // ── 换发型 ───────────────────────────────────────────────────
  {
    id: 'fal/hair-change',
    providerId: 'fal',
    endpoint: 'fal-ai/image-apps-v2/hair-change',
    kind: 'hair',
    label: '发型更换',
    // 官方 llms.txt 标价 $0.04/image
    costUsdPerRun: 0.04,
    license: 'commercial',
    tier: 'standard',
  },
] as const

/** 按 id 索引，供按 id 精确取用（例如重试某个历史任务时锁定原模型） */
export const MODEL_BY_ID: ReadonlyMap<string, ModelSpec> = new Map(
  MODELS.map((model) => [model.id, model]),
)

export function getModelById(id: string): ModelSpec | undefined {
  return MODEL_BY_ID.get(id)
}
