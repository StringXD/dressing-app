import { db } from '@/lib/db'
import { assets } from '@/lib/db/schema'
import { UnsupportedImageError, normalizeImage } from '@/lib/image/normalize'
import { requireSessionId } from '@/lib/session'
import { buildStorageKey, storage } from '@/lib/storage'

/** 单次请求最多接收的图片数。一次上传一整柜衣服没有意义，也容易打爆内存。 */
const MAX_FILES_PER_REQUEST = 10

interface UploadedAsset {
  id: string
  url: string
  mime: string
  width: number
  height: number
  bytes: number
}

interface UploadFailure {
  filename: string
  reason: string
}

/**
 * 图片上传。
 *
 * 一次可传多张，且**按文件粒度**返回成败 —— 批量上传时"3 张成功 1 张格式不对"
 * 是常见情况，整单失败会让用户反复重试，体验很差。
 *
 * 语义上不区分"人物照"和"服装图"，两者都只是 asset；
 * 由调用方（Agent 或工作台）决定怎么用。
 */
export async function POST(request: Request) {
  const sessionId = await requireSessionId()

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return Response.json(
      { error: '请求体解析失败，请以 multipart/form-data 提交' },
      { status: 400 },
    )
  }

  const files = formData.getAll('file').filter((v): v is File => v instanceof File)

  if (files.length === 0) {
    return Response.json({ error: '没有收到文件（字段名应为 file）' }, { status: 400 })
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return Response.json(
      { error: `一次最多上传 ${MAX_FILES_PER_REQUEST} 张，收到 ${files.length} 张` },
      { status: 400 },
    )
  }

  const uploaded: UploadedAsset[] = []
  const failed: UploadFailure[] = []

  for (const file of files) {
    const filename = file.name || '(未命名)'

    // 提前按 Content-Length 拦一道，避免把超大文件整个读进内存才发现超限
    if (file.size > 0 && file.size > 64 * 1024 * 1024) {
      failed.push({ filename, reason: '文件过大' })
      continue
    }

    const assetId = crypto.randomUUID()
    let storageKey: string | null = null

    try {
      const input = Buffer.from(await file.arrayBuffer())
      const normalized = await normalizeImage(input)

      storageKey = buildStorageKey('uploads', sessionId, assetId, normalized.ext)
      const stored = await storage.put(storageKey, normalized.buffer, { mime: normalized.mime })

      await db.insert(assets).values({
        id: assetId,
        sessionId,
        kind: 'upload',
        storageKey: stored.key,
        mime: normalized.mime,
        width: normalized.width,
        height: normalized.height,
        bytes: normalized.bytes,
      })

      uploaded.push({
        id: assetId,
        url: storage.url(stored.key),
        mime: normalized.mime,
        width: normalized.width,
        height: normalized.height,
        bytes: normalized.bytes,
      })
    } catch (error) {
      // 已经落盘但入库失败时清掉文件，否则会积累永远查不到的孤儿文件
      if (storageKey) {
        await storage.delete(storageKey).catch(() => {})
      }

      failed.push({
        filename,
        reason:
          error instanceof UnsupportedImageError
            ? error.message
            : `处理失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  // 全部失败 → 4xx；部分成功 → 200 但带上 failed 明细
  const status = uploaded.length === 0 ? 422 : 200

  return Response.json({ assets: uploaded, failed }, { status })
}
