import type { TryOnInput, HairInput, TaskInput } from '../types'

/** fal 端点的请求体。字段名各异，最终由 fal client 按端点 schema 校验。 */
export type FalInput = Record<string, unknown>

/** 已上传到 fal 存储、上游可直接抓取的图片 URL */
export interface ResolvedImageUrls {
  person: string
  garment?: string
}

export class UnsupportedEndpointError extends Error {
  constructor(endpoint: string) {
    super(`未在参数映射表中登记的 fal 端点：${endpoint}`)
    this.name = 'UnsupportedEndpointError'
  }
}

export class TaskKindMismatchError extends Error {
  constructor(endpoint: string, expected: string, actual: string) {
    super(`端点 ${endpoint} 只接受 ${expected} 任务，收到 ${actual}`)
    this.name = 'TaskKindMismatchError'
  }
}

interface TryOnMapping {
  kind: 'tryon'
  personField: string
  garmentField: string
  mapParams: (input: TryOnInput, urls: Required<ResolvedImageUrls>) => FalInput
}

interface HairMapping {
  kind: 'hair'
  personField: string
  mapParams: (input: HairInput, urls: ResolvedImageUrls) => FalInput
}

type EndpointMapping = TryOnMapping | HairMapping

/**
 * 端点 → 参数映射表。
 *
 * 这张表就是"新增一个 fal 模型要改的全部"：
 * 在 models.config.ts 加一行，在这里加一个条目，其余代码不用动。
 *
 * 所有字段名与枚举取值均已对照 fal 官方 llms.txt 核验。
 */
export const ENDPOINT_MAPPINGS: Record<string, EndpointMapping> = {
  // $0.075/张，864×1296。唯一显式支持平铺图（garment_photo_type: flat-lay）的端点，
  // 文档明确提到能渲染服装上的文字与图案，因此作为商品图试穿的首选。
  'fal-ai/fashn/tryon/v1.6': {
    kind: 'tryon',
    personField: 'model_image',
    garmentField: 'garment_image',
    mapParams: (input, urls) => ({
      model_image: urls.person,
      garment_image: urls.garment,
      category: input.category,
      mode: input.mode,
      garment_photo_type: input.garmentPhotoType,
    }),
  },

  // $0.04/张，可出 4K。参数最简，作为试穿的经济档与失败降级目标。
  'fal-ai/image-apps-v2/virtual-try-on': {
    kind: 'tryon',
    personField: 'person_image_url',
    garmentField: 'clothing_image_url',
    mapParams: (input, urls) => ({
      person_image_url: urls.person,
      clothing_image_url: urls.garment,
      // 试穿场景要保留原始姿态，否则人物姿势会被上游重绘
      preserve_pose: true,
    }),
  },

  // $0.04/张。用枚举而非 prompt 控制发型与发色，UI 可做成纯下拉选择。
  'fal-ai/image-apps-v2/hair-change': {
    kind: 'hair',
    personField: 'image_url',
    mapParams: (input, urls) => ({
      image_url: urls.person,
      target_hairstyle: input.hairstyle,
      hair_color: input.color,
    }),
  },
}

/**
 * 把统一任务输入翻译成某端点的请求体。
 *
 * 会校验任务类型与端点是否匹配 —— 把换发型参数发给试穿端点会被上游
 * 以难以理解的方式拒绝，在本地提前拦下能省很多排查时间。
 */
export function mapParams(
  endpoint: string,
  input: TaskInput,
  urls: ResolvedImageUrls,
): FalInput {
  const mapping = ENDPOINT_MAPPINGS[endpoint]
  if (!mapping) {
    throw new UnsupportedEndpointError(endpoint)
  }

  if (mapping.kind !== input.kind) {
    throw new TaskKindMismatchError(endpoint, mapping.kind, input.kind)
  }

  // 下面两段的 input.kind 复检在运行时永远不会触发（上面已经比对过），
  // 它们是为了让 TS 把 input 收窄到具体成员 —— 删掉会直接编译不过。
  if (mapping.kind === 'tryon') {
    if (input.kind !== 'tryon') throw new TaskKindMismatchError(endpoint, 'tryon', input.kind)
    if (!urls.garment) {
      throw new Error(`端点 ${endpoint} 需要服装图，但没有提供`)
    }
    return mapping.mapParams(input, { person: urls.person, garment: urls.garment })
  }

  if (input.kind !== 'hair') throw new TaskKindMismatchError(endpoint, 'hair', input.kind)
  return mapping.mapParams(input, urls)
}

/**
 * 该端点需要上传哪些图片。
 *
 * adapter 靠它决定要不要上传服装图 —— 换发型端点没有服装图，
 * 多传一次会白白多一轮网络往返。
 */
export function getImageFields(endpoint: string): {
  personField: string
  garmentField?: string
} {
  const mapping = ENDPOINT_MAPPINGS[endpoint]
  if (!mapping) throw new UnsupportedEndpointError(endpoint)

  return mapping.kind === 'tryon'
    ? { personField: mapping.personField, garmentField: mapping.garmentField }
    : { personField: mapping.personField }
}
