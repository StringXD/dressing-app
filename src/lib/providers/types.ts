import type { TaskKind } from '@/lib/domain'

/**
 * 图片输入。
 *
 * 携带**原始字节**而不是 URL，是刻意的：我们的图片放在鉴权路由后面
 * （`/api/files/*` 需要会话 cookie），上游模型服务根本抓不到。
 * 由各 adapter 自己负责把字节送到上游能访问的位置
 * （fal 用 `storage.upload()` 换公开 URL）。
 *
 * 这样换上游时，存储与鉴权策略完全不用动。
 */
export interface ImageInput {
  bytes: Buffer
  mime: string
  /** 部分上游按文件名推断格式 */
  filename: string
}

/** 上游模型自己的参数词表 —— 与 @/lib/domain 的 GarmentPhotoType 语义不同，不要混用 */
export const GARMENT_CATEGORIES = ['auto', 'tops', 'bottoms', 'one-pieces'] as const
export type GarmentCategory = (typeof GARMENT_CATEGORIES)[number]

export const TRYON_MODES = ['performance', 'balanced', 'quality'] as const
export type TryOnMode = (typeof TRYON_MODES)[number]

/** 上游的取值：'auto' 表示由模型自己判断 */
export const UPSTREAM_PHOTO_TYPES = ['auto', 'model', 'flat-lay'] as const
export type UpstreamPhotoType = (typeof UPSTREAM_PHOTO_TYPES)[number]

/**
 * 发型与发色 —— 取值直接对齐 fal `image-apps-v2/hair-change` 的枚举。
 * 这是该端点的**白送能力**：18×18 个选项意味着换发型 UI 可以做成
 * 零 prompt 工程的下拉选择器。
 */
export const HAIRSTYLES = [
  'short_hair',
  'medium_long_hair',
  'long_hair',
  'curly_hair',
  'wavy_hair',
  'high_ponytail',
  'bun',
  'bob_cut',
  'pixie_cut',
  'braids',
  'straight_hair',
  'afro',
  'dreadlocks',
  'buzz_cut',
  'mohawk',
  'bangs',
  'side_part',
  'middle_part',
] as const
export type Hairstyle = (typeof HAIRSTYLES)[number]

export const HAIRSTYLE_LABELS: Record<Hairstyle, string> = {
  short_hair: '短发',
  medium_long_hair: '中长发',
  long_hair: '长发',
  curly_hair: '卷发',
  wavy_hair: '波浪卷',
  high_ponytail: '高马尾',
  bun: '丸子头',
  bob_cut: '波波头',
  pixie_cut: '精灵短发',
  braids: '编发',
  straight_hair: '直发',
  afro: '爆炸头',
  dreadlocks: '脏辫',
  buzz_cut: '寸头',
  mohawk: '莫西干',
  bangs: '齐刘海',
  side_part: '侧分',
  middle_part: '中分',
}

export const HAIR_COLORS = [
  'black',
  'dark_brown',
  'light_brown',
  'blonde',
  'platinum_blonde',
  'red',
  'auburn',
  'gray',
  'silver',
  'blue',
  'green',
  'purple',
  'pink',
  'rainbow',
  'natural',
  'highlights',
  'ombre',
  'balayage',
] as const
export type HairColor = (typeof HAIR_COLORS)[number]

export const HAIR_COLOR_LABELS: Record<HairColor, string> = {
  black: '自然黑',
  dark_brown: '深棕',
  light_brown: '浅棕',
  blonde: '金发',
  platinum_blonde: '铂金',
  red: '红色',
  auburn: '红棕',
  gray: '灰色',
  silver: '银色',
  blue: '蓝色',
  green: '绿色',
  purple: '紫色',
  pink: '粉色',
  rainbow: '彩虹',
  natural: '保持原色',
  highlights: '挑染',
  ombre: '渐变',
  balayage: '巴黎画染',
}

/**
 * 统一的生成任务输入。
 *
 * 用判别联合表达两类任务 —— 它们对参数的诉求差别很大
 * （换装要服装图与类目，换发型要发型与发色枚举），
 * 强行合并成一个宽结构只会让两边都拿到一堆用不上的可选项。
 */
export interface TryOnInput {
  kind: 'tryon'
  person: ImageInput
  garment: ImageInput
  category: GarmentCategory
  mode: TryOnMode
  garmentPhotoType: UpstreamPhotoType
}

export interface HairInput {
  kind: 'hair'
  person: ImageInput
  hairstyle: Hairstyle
  color: HairColor
}

export type TaskInput = TryOnInput | HairInput

/**
 * 模型授权。
 *
 * **这是给使用者的警示，不是项目的自我审查**：本项目自身不商业化，
 * 因此收录 `research`（禁商用）条目是允许的 —— 效果优先，由使用者按用途取舍。
 * 但 `license` 必须如实标注，README 的商用替代清单也要同步更新，
 * 否则就成了让使用者在不知情的情况下承担法律风险。
 */
export type ModelLicense = 'commercial' | 'research'

export type ModelTier = 'premium' | 'standard' | 'budget'

export interface ModelSpec {
  /** 内部稳定标识，会写进 generations.model_id */
  id: string
  providerId: string
  /** 上游端点标识 */
  endpoint: string
  kind: TaskKind
  label: string
  /** 单次调用成本（USD），用于记账与预算控制 */
  costUsdPerRun: number
  license: ModelLicense
  tier: ModelTier
}

export interface SubmitResult {
  providerJobId: string
}

export type PollResult =
  | { state: 'pending' }
  | { state: 'succeeded'; raw: unknown }
  | { state: 'failed'; code: string; message: string }

/**
 * 已出结果的轮询结果 —— 排除掉 'pending'。
 *
 * 轮询循环按构造只会返回终态，把这个不变量写进类型，
 * 调用方就不必再为"万一还是 pending"写分支（那种分支永远测不到）。
 */
export type SettledPollResult = Exclude<PollResult, { state: 'pending' }>

export interface NormalizedOutput {
  imageUrl: string
}

export interface ProviderAdapter {
  readonly id: string

  /** 提交任务，返回上游任务 id。不阻塞等待结果 —— 排队由我们自己的队列控制。 */
  submit(model: ModelSpec, input: TaskInput): Promise<SubmitResult>

  /** 查询一次上游状态。由队列在合适时机调用，不要在这里轮询。 */
  poll(model: ModelSpec, providerJobId: string): Promise<PollResult>

  /** 把上游返回体转成统一结构。上游格式变了只需要改这里。 */
  normalizeResult(model: ModelSpec, raw: unknown): NormalizedOutput
}
