import { createFalAdapter } from './fal/adapter'
import type { ProviderAdapter } from './types'

export * from './types'
export { MODELS, MODEL_BY_ID, getModelById } from './models.config'
export {
  resolveModel,
  resolveCheaperFallback,
  listModels,
  NoModelAvailableError,
} from './registry'

/**
 * provider 实例缓存。
 *
 * adapter 内部持有"是否已配置 credentials"的状态，因此必须复用实例 ——
 * 每次新建会导致重复配置，也让日志难以追踪。
 */
const instances = new Map<string, ProviderAdapter>()

function create(providerId: string): ProviderAdapter {
  switch (providerId) {
    case 'fal':
      return createFalAdapter()

    // 预留：自建推理服务。接口契约见计划文档「阶段 7」——
    // POST /v1/jobs 提交、GET /v1/jobs/:id 查询，形状与 fal queue 对齐，
    // 因此 SelfHostedAdapter 与 FalAdapter 在编排层可互换。
    case 'selfhosted':
      throw new Error('selfhosted provider 尚未实现（见计划文档阶段 7 的接口契约）')

    default:
      throw new Error(`未知的 provider：${providerId}`)
  }
}

export function getProvider(providerId: string): ProviderAdapter {
  const existing = instances.get(providerId)
  if (existing) return existing

  const created = create(providerId)
  instances.set(providerId, created)
  return created
}
