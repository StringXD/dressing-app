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

/** 商品图实际是什么形态 —— 描述事实 */
export const GARMENT_PHOTO_TYPES = ['flat-lay', 'model', 'unknown'] as const
export type GarmentPhotoType = (typeof GARMENT_PHOTO_TYPES)[number]

/**
 * 本项目要打的目标电商平台。
 *
 * 这几个是国内反爬最强的一组，解析难度天差地别，因此必须能区分出来 ——
 * `garments.platform` 记录命中的平台，用来回答"淘宝到底有几成能自动解析"。
 *
 * 注意：能识别出平台**不等于**能解析它。实测京东商品页是纯 JS 渲染，
 * 识别成功但结构化提取拿不到图，最终仍会降级到让用户发截图。
 */
export const PLATFORMS = [
  'taobao',
  'tmall',
  'jd',
  'pdd',
  'xiaohongshu',
  'douyin',
  'dewu',
  'other',
] as const
export type Platform = (typeof PLATFORMS)[number]

/** 各平台的中文名，用于界面上告诉用户"识别到淘宝链接" */
export const PLATFORM_LABELS: Record<Platform, string> = {
  taobao: '淘宝',
  tmall: '天猫',
  jd: '京东',
  pdd: '拼多多',
  xiaohongshu: '小红书',
  douyin: '抖音',
  dewu: '得物',
  other: '其他网站',
}

/** 服装是怎么来的 —— 描述来源 */
export const GARMENT_SOURCE_KINDS = ['link', 'screenshot'] as const
export type GarmentSourceKind = (typeof GARMENT_SOURCE_KINDS)[number]

/**
 * 链接解析命中的降级层级。**这里是取值集合**，尝试次序见 TIER_ORDER。
 * 记录下来是为了能回答"淘宝的链接到底有几成能自动解析"这类问题 ——
 * 没有这个数据，降级链就是黑盒。
 */
export const RESOLVE_TIERS = ['onebound', 'firecrawl', 'jina', 'structured', 'vlm', 'manual'] as const
export type ResolveTier = (typeof RESOLVE_TIERS)[number]

/**
 * 尝试次序：从便宜/精准的往贵/模糊的降级。
 *
 * 与 RESOLVE_TIERS 的声明顺序**故意不同**，别再把它写回 RESOLVE_TIERS 的顺序：
 *  - `structured`（我们自己解析 HTML）是免费的，且对服务端渲染的站点最准，
 *    所以排在 jina / firecrawl 之前 —— 那两个要渲染 JS，慢且（firecrawl）花钱。
 *    先花一次失败的 HTTP 请求换掉大部分付费调用，很划算。
 *  - `onebound` 是平台专用 API，最准但有成本，且只覆盖淘宝/京东，排在最前。
 *  - `vlm` 是截图识图，慢且贵，只在前面的都拿不到图时才用。
 *  - `manual` 永远可用：引导用户直接发商品截图。国内用户本就习惯截图分享，
 *    这条路不受任何反爬影响，是一等公民而不是兜底。
 *
 * 该次序只影响应用层重试顺序，不落库、无需迁移
 * （resolved_by 是普通 text 列，已核对 drizzle/0000_thankful_warpath.sql）。
 */
export const TIER_ORDER: readonly ResolveTier[] = [
  'onebound',
  'structured',
  'jina',
  'firecrawl',
  'vlm',
  'manual',
]
