import { and, desc, eq, inArray } from 'drizzle-orm'

import { db } from '@/lib/db'
import { assets, garments } from '@/lib/db/schema'
import type { GarmentPhotoType } from '@/lib/domain'
import { storage } from '@/lib/storage'
import { listRecentPhotos, type PhotoCandidate } from './photos'

/**
 * 工作台的素材清单：能选的人物照，与已经认出来的服装。
 *
 * ── 为什么服装走 `garments` 表，而不是接着用"反推用途" ──────────────────
 * `listRecentPhotos` 反推的是"这张**上传图**被当作服装用过"，回答"我传过哪些图"。
 * 工作台要的是"我有哪些**能选的服装**"，而服装是 `garments` 行：它有 title 与
 * color 可以显示，而且它的 `id` 正是 `batchTryOn` 参数里那个 `garmentIds`。
 * 两者不是一回事 —— 一张服装图能被识别成一条 garments 记录，而上传图本身
 * 没有标题可显示。选错的那个（拿 assetId 当 garmentId）会静默失败：工具会说
 * "找不到这件衣服"，而用户明明看见了它。
 *
 * 反过来，人物照那侧**必须**复用 `listRecentPhotos`：那里已经有一份
 * "哪些上传图当过人物照"的定义，再写一遍就是第二份会漂移的真相。
 *
 * ── 窗口 ──────────────────────────────────────────────────────────
 * 两边都是"最近 N 条"，不是全量。这个上限有意义：它是给用户挑素材用的清单，
 * 不是文件管理器。但要如实承认它的后果 —— 上传了几十张服装图之后，
 * 更早的人物照会滑出窗口。
 */

/** 一次最多列多少条。人物照与服装各自独立计这个数 */
export const WORKBENCH_LIMIT = 60

export interface WorkbenchPerson {
  assetId: string
  url: string
  uploadedAt: string
}

export interface WorkbenchGarment {
  /** 交给 `batchTryOn` 的就是它 */
  garmentId: string
  assetId: string
  url: string
  title: string | null
  color: string | null
  photoType: GarmentPhotoType
}

export interface WorkbenchItems {
  people: WorkbenchPerson[]
  garments: WorkbenchGarment[]
}

/** `listWorkbenchItems` 查出来的服装行，只取要用的列 */
export interface GarmentRow {
  id: string
  assetId: string
  title: string | null
  color: string | null
  photoType: GarmentPhotoType
}

/**
 * 把三份数据拼成清单。纯函数（不碰 db），好让"哪些图片能出现在网格里"
 * 这条判断被单测直接钉住 —— 与 `buildPhotoCandidates` 同一条理由。
 *
 * 取不到 URL 的条目直接丢掉。这一条不是防御性的：`garments.asset_id` 是
 * cascade 外键，所以理论上不会缺。写成过滤是为了让类型收窄，
 * 而不是兜住某个已知情况 —— 别把它当成"已经处理过"的保证。
 */
export function buildWorkbenchItems(
  photos: PhotoCandidate[],
  garmentRows: GarmentRow[],
  urlByAssetId: ReadonlyMap<string, string>,
): WorkbenchItems {
  /*
   * 只取真的当过人物照的。
   *
   * `unused` 是"我们不知道这张图是什么"——它从没进过任何一次生成，
   * 也没被认成服装。把一张来历不明的图摆进"选一张人物照"的网格，
   * 等于请用户拿它去花钱，而我们连它是不是全身照都没看过。
   * 模型被明确要求在这种情况下先问用户（见 inspectPhoto 的短路逻辑）。
   */
  const people = photos
    .filter((photo) => photo.usage === 'person' || photo.usage === 'both')
    .flatMap((photo) => {
      const url = urlByAssetId.get(photo.assetId)
      return url ? [{ assetId: photo.assetId, url, uploadedAt: photo.uploadedAt.toISOString() }] : []
    })

  const garmentItems = garmentRows.flatMap((row) => {
    const url = urlByAssetId.get(row.assetId)
    return url
      ? [
          {
            garmentId: row.id,
            assetId: row.assetId,
            url,
            title: row.title,
            color: row.color,
            photoType: row.photoType,
          },
        ]
      : []
  })

  return { people, garments: garmentItems }
}

/**
 * 查工作台要的素材。
 *
 * `sessionId` 必填而不是可选，理由同 `listRecentPhotos`：没有任何合理场景
 * 需要跨会话查询，做成可选迟早有人传 undefined。
 */
export async function listWorkbenchItems(
  sessionId: string,
  { limit = WORKBENCH_LIMIT }: { limit?: number } = {},
): Promise<WorkbenchItems> {
  const [photos, garmentRows] = await Promise.all([
    listRecentPhotos(sessionId, { limit }),
    db
      .select({
        id: garments.id,
        assetId: garments.assetId,
        title: garments.title,
        color: garments.color,
        photoType: garments.photoType,
      })
      .from(garments)
      .where(eq(garments.sessionId, sessionId))
      .orderBy(desc(garments.createdAt))
      .limit(limit),
  ])

  const assetIds = [...new Set([...photos.map((p) => p.assetId), ...garmentRows.map((g) => g.assetId)])]

  const urlByAssetId = new Map<string, string>()

  // 空数组时不能查：`inArray(col, [])` 会生成恒假的谓词，白白多一次往返
  if (assetIds.length > 0) {
    const rows = await db
      .select({ id: assets.id, storageKey: assets.storageKey })
      .from(assets)
      .where(and(eq(assets.sessionId, sessionId), inArray(assets.id, assetIds)))

    for (const row of rows) {
      urlByAssetId.set(row.id, storage.url(row.storageKey))
    }
  }

  return buildWorkbenchItems(photos, garmentRows, urlByAssetId)
}
