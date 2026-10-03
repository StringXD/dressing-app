import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

import { env } from '@/lib/env'

import { isValidStorageKey, type PutOptions, type StorageAdapter, type StoredObject } from './types'

/**
 * 本地磁盘实现。仅用于开发 —— 容器重建即丢，也不支持多实例。
 * 上线请切 R2（见 storage/r2.ts 的位置预留）。
 */
export function createLocalStorage(): StorageAdapter {
  const root = resolve(env.STORAGE_LOCAL_DIR)

  /**
   * key → 绝对路径。这里做两道校验：
   * ① 白名单式格式校验（挡掉 `..`、绝对路径、未知扩展名）
   * ② resolve 后再确认结果仍在 root 之内
   * 单靠任一道都不够稳妥，两道一起才能在有人放宽 KEY_PATTERN 时仍然安全。
   */
  function toAbsolutePath(key: string): string {
    if (!isValidStorageKey(key)) {
      throw new Error(`非法存储 key：${key}`)
    }
    const absolute = resolve(root, key)
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new Error(`存储 key 越出根目录：${key}`)
    }
    return absolute
  }

  return {
    id: 'local',

    async put(key: string, body: Buffer, options: PutOptions): Promise<StoredObject> {
      const absolute = toAbsolutePath(key)
      await mkdir(dirname(absolute), { recursive: true })
      await writeFile(absolute, body)
      return { key, mime: options.mime, bytes: body.byteLength }
    },

    async get(key: string) {
      const absolute = toAbsolutePath(key)
      try {
        const body = await readFile(absolute)
        return { body, mime: inferMimeFromKey(key) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },

    async delete(key: string): Promise<void> {
      const absolute = toAbsolutePath(key)
      try {
        await unlink(absolute)
      } catch (error) {
        // 不存在视为成功，保持幂等
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },

    url(key: string): string {
      return `${env.STORAGE_LOCAL_BASE_URL}/${key}`
    },
  }
}

function inferMimeFromKey(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    default:
      return 'image/webp'
  }
}
