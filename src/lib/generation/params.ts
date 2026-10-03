import { z } from 'zod'

import type { TaskKind } from '@/lib/domain'
import {
  GARMENT_CATEGORIES,
  HAIRSTYLES,
  HAIR_COLORS,
  TRYON_MODES,
  UPSTREAM_PHOTO_TYPES,
} from '@/lib/providers/types'

/**
 * 一个生成任务里**与图片无关**的那部分参数。
 *
 * 图片刻意不进这里：`generations.params` 是 jsonb，而 TaskInput 里的图片是原始字节，
 * 塞进 DB 既浪费空间又让备份变成怪物。图片始终以 asset 引用（personAssetId / garmentId）
 * 存在，Worker 开工时再去存储层取字节。
 *
 * 枚举值直接复用 provider 层的定义 —— 这些就是上游接受的取值，
 * 在这里另抄一份迟早会漂移。
 */
export const tryOnParamsSchema = z.object({
  category: z.enum(GARMENT_CATEGORIES),
  mode: z.enum(TRYON_MODES),
  garmentPhotoType: z.enum(UPSTREAM_PHOTO_TYPES),
})

export const hairParamsSchema = z.object({
  hairstyle: z.enum(HAIRSTYLES),
  color: z.enum(HAIR_COLORS),
})

export type TryOnParams = z.infer<typeof tryOnParamsSchema>
export type HairParams = z.infer<typeof hairParamsSchema>
export type GenerationParams = TryOnParams | HairParams

export class InvalidGenerationParamsError extends Error {
  constructor(taskKind: TaskKind, detail: string) {
    super(`generations.params 与任务类型 ${taskKind} 不匹配：${detail}`)
    this.name = 'InvalidGenerationParamsError'
  }
}

/**
 * 任务类型 → 参数类型的映射。
 * 有了它，调用方传 'tryon' 字面量就能直接拿到 TryOnParams，
 * 不必在每一处再写一次类型断言。
 */
export interface ParamsByTaskKind {
  tryon: TryOnParams
  hair: HairParams
}

/**
 * 把 DB 里读回来的 jsonb 校验成有类型的参数。
 *
 * 必须校验而不能直接断言：jsonb 是弱类型的，任何一次 schema 演进、手工改库、
 * 或将来别的写入方都可能留下形状不对的数据。这里拦下，好过在 provider 层
 * 以一个看不懂的错误炸掉（而那时可能已经花掉一次调用的钱）。
 */
export function parseGenerationParams<K extends TaskKind>(
  taskKind: K,
  raw: unknown,
): ParamsByTaskKind[K] {
  const schema = taskKind === 'tryon' ? tryOnParamsSchema : hairParamsSchema
  const result = schema.safeParse(raw)

  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new InvalidGenerationParamsError(taskKind, detail)
  }

  return result.data as ParamsByTaskKind[K]
}
