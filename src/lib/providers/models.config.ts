import type { ModelSpec } from './types'

/**
 * 模型注册表。
 *
 * **纯数据** —— 新增端点、调整价格、切换降级档位都只改这里，不触碰编排、API 与前端。
 *
 * 所有条目都已逐个核对过 fal 官方 schema 与价格（见各条 comment）。
 *
 * ⚠️ **`license` 是给使用者的警示，不是项目的自我审查。**
 * 本项目不限制自己只用可商用模型 —— 效果优先，由使用者按自己的用途取舍：
 *  - `commercial`：可放心用于商业项目
 *  - `research`：禁商用。自己玩没问题，拿去赚钱有法律风险
 * 需要商用时，只挑 `commercial` 的条目（README 有对应清单）。
 *
 * 已知尚未收录的候选：`fal-ai/cat-vton`（licenseType 为 research，见 fal schema）。
 * 按"效果优先"的原则它值得评估后收录，但**必须先拿真实照片实测过再加** ——
 * 只凭调研印象就入库，会让注册表里出现一个没人验证过的条目。
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
