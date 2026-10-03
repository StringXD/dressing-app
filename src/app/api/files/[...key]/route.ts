import { isValidStorageKey, storage } from '@/lib/storage'
import { getSessionId } from '@/lib/session'

/**
 * 读取存储中的图片。
 *
 * **归属校验不查数据库**：存储 key 的形状是 `<kind>/<sessionId>/<assetId>.<ext>`，
 * 第二段就是拥有者。直接把它和当前 cookie 里的 sessionId 比对即可，
 * 每次图片请求省掉一次查询 —— 相册页一次要加载几十张图，这个差别很实在。
 *
 * 想分享图片给他人时，这个策略需要改（加签名 URL），但第一版没有分享需求。
 */
export async function GET(
  _request: Request,
  ctx: RouteContext<'/api/files/[...key]'>,
): Promise<Response> {
  const segments = (await ctx.params).key

  // 注意：先 join 再校验，与 StorageAdapter 用的是同一套规则，避免两处判断不一致
  const key = segments.join('/')

  if (!isValidStorageKey(key)) {
    return new Response('Not Found', { status: 404 })
  }

  const ownerSessionId = segments[1]
  const currentSessionId = await getSessionId()

  // 统一返回 404 而不是 403：不暴露"这个 key 存在但不属于你"
  if (!currentSessionId || ownerSessionId !== currentSessionId) {
    return new Response('Not Found', { status: 404 })
  }

  const object = await storage.get(key)
  if (!object) {
    return new Response('Not Found', { status: 404 })
  }

  return new Response(new Uint8Array(object.body), {
    headers: {
      'Content-Type': object.mime,
      'Content-Length': String(object.body.byteLength),
      // key 内含随机 UUID，内容不会变，可以放心长缓存
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  })
}
