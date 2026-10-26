import { and, desc, eq, inArray } from 'drizzle-orm'

import { db } from '@/lib/db'
import { assets, garments, generations } from '@/lib/db/schema'

/**
 * 「我传过哪些图」。
 *
 * 存在的理由是一个真实的失败：用户刷新页面后问"我适合什么风格"，
 * 模型**手里一个 assetId 都没有** —— 图片的 assetId 只活在消息里
 * （见 `lib/chat/annotations.ts` 的标注行）。
 *
 * ⚠️ 这条理由在**对话落库之后变窄了，但没有消失**。消息现在会往返，
 * 所以刷新不再丢 id。可是 id 只在**这一次对话**里：用户开一次新对话、
 * 或者那张图是他在别的对话里传的，模型手里就还是没有它 ——
 * 于是它又说"请重新上传一张全身照"，而照片明明还在库里。
 * 换句话说，这个工具回答的是"**我这个会话**传过什么"，
 * 它的寿命比任何一次对话都长。
 *
 * ── 为什么是"反推用途"而不是加一个 role 列 ──────────────────────
 * `assets` 表刻意不区分人物照与服装图（见 `api/upload/route.ts`：
 * "语义上不区分…由调用方决定怎么用"）。那个判断是对的：同一张图
 * 这次当人物照、下次可能就是拿来对着找衣服的参考图，角色是**用途**而非固有属性。
 *
 * 所以这里不新增列，而是问"这张图实际被用在哪了"：
 * 当过 `generations.personAssetId` 的就是人物照，被 `garments` 引用过的就是服装图。
 * 没被用过的既不是这个也不是那个 —— 工具如实说"不知道"，让模型去问用户，
 * 而不是猜一个。
 */

/** 这张图实际被用在了哪 */
export type PhotoUsage = 'person' | 'garment' | 'both' | 'unused'

export interface PhotoCandidate {
  assetId: string
  uploadedAt: Date
  usage: PhotoUsage
}

/** `listRecentPhotos` 的输入行，只取真正要用的列 */
export interface PhotoRow {
  id: string
  createdAt: Date
}

/**
 * 按用途给每张上传图打标。
 *
 * 纯函数（不碰 db）是为了让"归属过滤到底有没有生效"能被单测直接钉住 ——
 * 与 `buildResultViews` 同一条理由：那个 Map 里出现不属于本会话的 id，
 * 就意味着这里能把别人的照片列出来。
 */
export function buildPhotoCandidates(
  rows: PhotoRow[],
  personAssetIds: ReadonlySet<string>,
  garmentAssetIds: ReadonlySet<string>,
): PhotoCandidate[] {
  return rows.map((row) => {
    const asPerson = personAssetIds.has(row.id)
    const asGarment = garmentAssetIds.has(row.id)

    return {
      assetId: row.id,
      uploadedAt: row.createdAt,
      usage: asPerson && asGarment ? 'both' : asPerson ? 'person' : asGarment ? 'garment' : 'unused',
    }
  })
}

export interface ListPhotosOptions {
  /** 最多列几张。这是给模型看的候选清单，不是文件管理器 */
  limit: number
}

/**
 * 查本会话上传过的图片，最近的在前。
 *
 * `sessionId` 必填而不是可选，理由同 `listRecentResults`：
 * 没有任何合理场景需要跨会话查询，做成可选迟早有人传 undefined。
 */
export async function listRecentPhotos(
  sessionId: string,
  { limit }: ListPhotosOptions,
): Promise<PhotoCandidate[]> {
  const uploads = await db
    .select({ id: assets.id, createdAt: assets.createdAt })
    .from(assets)
    .where(and(eq(assets.sessionId, sessionId), eq(assets.kind, 'upload')))
    .orderBy(desc(assets.createdAt))
    .limit(limit)

  if (uploads.length === 0) return []

  const ids = uploads.map((row) => row.id)

  /*
   * 两次用途查询都带 sessionId。
   *
   * 少了它，"这张图被用过作人物照"这个判断就可以由**别人的**任务来满足：
   * 一个被改过 conversationId / 归属的库能让我看到"我传的图是别人的素材"。
   * 与 listRecentResults 里那次资产二次校验是同一条原则。
   */
  const [personUses, garmentUses] = await Promise.all([
    db
      .selectDistinct({ assetId: generations.personAssetId })
      .from(generations)
      .where(
        and(eq(generations.sessionId, sessionId), inArray(generations.personAssetId, ids)),
      ),
    db
      .selectDistinct({ assetId: garments.assetId })
      .from(garments)
      .where(and(eq(garments.sessionId, sessionId), inArray(garments.assetId, ids))),
  ])

  return buildPhotoCandidates(
    uploads,
    new Set(personUses.map((row) => row.assetId)),
    new Set(garmentUses.map((row) => row.assetId)),
  )
}
