import type { Platform, ResolveTier } from '@/lib/domain'

/**
 * 一个候选商品图。
 *
 * 返回**列表**而不是单张：商品页往往同时给出主图、细节图、模特图，
 * 而"哪张适合做试穿"取决于它是平铺图还是上身图 —— 这个判断交给
 * 用户或后续的视觉模型，比在这里写死一张更靠谱。
 */
export interface ResolveCandidate {
  imageUrl: string
  /** 图片在其来源页面上的用途/大小提示，便于排序与展示 */
  label?: string
}

/** 记录每一档的尝试结果，既用于诊断，也用于在对话里如实告诉用户"卡在哪一步" */
export interface ResolveAttempt {
  tier: ResolveTier
  ok: boolean
  detail: string
  elapsedMs: number
}

export type ResolveOutcome =
  | {
      ok: true
      tier: ResolveTier
      /** 归一化后的最终地址（短链已展开） */
      finalUrl: string
      platform: Platform
      title: string | null
      candidates: ResolveCandidate[]
      attempts: ResolveAttempt[]
    }
  | {
      ok: false
      /** 失败时必然是 manual —— 引导用户发截图 */
      tier: 'manual'
      /** 短链展开后的地址；若连展开都失败则为 null */
      finalUrl: string | null
      platform: Platform
      /** 给用户看的一句话，说明为什么自动解析没能完成 */
      reason: string
      attempts: ResolveAttempt[]
    }

export interface ExtractSuccess {
  ok: true
  title?: string
  candidates: ResolveCandidate[]
  /** 档位可能顺带把地址归一化（例如代理服务返回的最终地址） */
  finalUrl?: string
}

export interface ExtractFailure {
  ok: false
  reason: string
}

export type ExtractResult = ExtractSuccess | ExtractFailure

/**
 * 可用性。
 *
 * 缺 Key 的档位不是"错误"，而是"这门功夫还没学会" ——
 * 编排层要安静跳过并记一笔，而不是让整条链路失败。
 * 这样在没有万邦 Key 的阶段，淘宝/京东链接也能正确地降级到 Tier D，
 * 而不是抛一个用户看不懂的异常。
 */
export type Availability = { available: true } | { available: false; reason: string }

export interface ExtractContext {
  finalUrl: string
  platform: Platform
  /** 全链路共享的超时控制，避免某一档把整体拖死 */
  signal?: AbortSignal
}

export interface Extractor {
  readonly tier: ResolveTier
  availability(): Availability
  extract(ctx: ExtractContext): Promise<ExtractResult>
}
