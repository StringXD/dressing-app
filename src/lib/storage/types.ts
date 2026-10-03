/**
 * 存储抽象。
 *
 * 开发用本地磁盘，上线切 Cloudflare R2（出网免费，适合"生成图被反复查看"的场景）。
 * 两种实现共用同一套 key 语义，业务代码不需要知道图存在哪儿。
 */

export interface PutOptions {
  /** MIME 类型，会作为 Content-Type 写回 */
  mime: string
}

export interface StoredObject {
  key: string
  mime: string
  bytes: number
}

export interface StorageAdapter {
  readonly id: 'local' | 'r2'

  /** 写入并返回实际落盘的元信息 */
  put(key: string, body: Buffer, options: PutOptions): Promise<StoredObject>

  /** 读取；不存在返回 null 而不是抛错，便于路由层直接转 404 */
  get(key: string): Promise<{ body: Buffer; mime: string } | null>

  /** 删除；不存在视为成功（幂等） */
  delete(key: string): Promise<void>

  /**
   * 面向浏览器的可访问 URL。
   * 本地实现走 /api/files/*，R2 实现返回公开域名。
   */
  url(key: string): string
}

/**
 * 校验存储 key。
 *
 * 这个校验是**安全边界**：/api/files/[...key] 会把用户传入的路径段直接交给
 * get()，若不校验就能用 `../../` 读到仓库里的任意文件。因此这里做白名单式
 * 校验（只允许已知目录 + UUID 文件名 + 已知扩展名），而不是黑名单式地过滤 `..`。
 *
 * key 由服务端生成（`uploads/<sessionId>/<assetId>.webp`），正常情况下必然通过。
 */
const KEY_PATTERN = /^(uploads|generated)\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(webp|png|jpe?g)$/

export function isValidStorageKey(key: string): boolean {
  if (key.length > 200) return false
  if (key.includes('..') || key.includes('//') || key.includes('\\')) return false
  return KEY_PATTERN.test(key)
}

export function buildStorageKey(
  kind: 'uploads' | 'generated',
  sessionId: string,
  assetId: string,
  ext: 'webp' | 'png' | 'jpg' | 'jpeg',
): string {
  const key = `${kind}/${sessionId}/${assetId}.${ext}`
  // 自检：生成的 key 必须能通过校验，否则说明调用方传了非法 id
  if (!isValidStorageKey(key)) {
    throw new Error(`生成了非法的存储 key：${key}`)
  }
  return key
}
