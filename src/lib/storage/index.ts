import { env } from '@/lib/env'

import { createLocalStorage } from './local'
import type { StorageAdapter } from './types'

const globalForStorage = globalThis as unknown as { __dressingStorage?: StorageAdapter }

function createStorage(): StorageAdapter {
  switch (env.STORAGE_DRIVER) {
    case 'local':
      return createLocalStorage()

    case 'r2':
      // 刻意抛错而不是静默退回本地磁盘：配置成 r2 说明预期是云端存储，
      // 悄悄写本地会导致上线后图片"消失"，且很难定位。
      throw new Error(
        'STORAGE_DRIVER=r2 尚未实现。请在 src/lib/storage/r2.ts 中实现 StorageAdapter 接口后接入；' +
          '本地开发请设 STORAGE_DRIVER=local。',
      )
  }
}

/** 进程内单例。与 db 同样的理由：避免开发模式热重载反复创建。 */
export const storage: StorageAdapter = globalForStorage.__dressingStorage ?? createStorage()

if (env.NODE_ENV !== 'production') {
  globalForStorage.__dressingStorage = storage
}

export type { StorageAdapter, StoredObject, PutOptions } from './types'
export { buildStorageKey, isValidStorageKey } from './types'
