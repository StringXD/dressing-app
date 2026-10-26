/**
 * 跨层共享的领域枚举。
 *
 * 单独放一个模块，是为了让 DB schema 与 provider 层都依赖它，
 * 而不是让 provider 层反过来去 import db/schema —— 依赖方向应当是从外向内。
 *
 * 注意：这里只放**真正的领域概念**。
 * 上游模型自己的参数词表（例如 fal 的 `garment_photo_type` 用 'auto' 而非 'unknown'）
 * 放在 providers/ 里，两者语义不同，不要强行合并。
 */

export const TASK_KINDS = ['tryon', 'hair'] as const
export type TaskKind = (typeof TASK_KINDS)[number]

/** 商品图实际是什么形态 —— 描述服装本身 */
export const GARMENT_PHOTO_TYPES = ['flat-lay', 'model', 'unknown'] as const
export type GarmentPhotoType = (typeof GARMENT_PHOTO_TYPES)[number]

/**
 * 单次批量试穿的张数硬上限。
 *
 * 放在这里而不是留在 `agent/tools.ts`，是因为**工作台网格也要用它**：
 * 网格要在用户点击发送**之前**就拦住超限的组合，而不是让工具事后拒绝。
 * 从 tools.ts 引会把整个 Agent 与数据库层拉进浏览器包，复制一个 8
 * 就会有两个会漂移的上限（表现是网格放行、工具报错）。
 *
 * 这不是保守，是算术：FASHN $0.075/张，8 张 = $0.6。
 * 一个没有上限的批量操作，模型一次误判就能刷掉几十美元 ——
 * 而 `personAssetIds × garmentIds` 是**乘法**，两边各给 10 个就是 100 张。
 */
export const BATCH_TRYON_MAX = 8
