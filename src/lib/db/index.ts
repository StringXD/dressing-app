import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

import { env } from '@/lib/env'

import * as schema from './schema'

/**
 * Next.js 开发模式下模块会随热重载反复求值，
 * 若不缓存就每次改代码都新建一个连接池，很快打满 Postgres 的 max_connections。
 * 生产环境每个进程只求值一次，不需要也不应该挂到 globalThis。
 */
const globalForDb = globalThis as unknown as { __dressingPool?: Pool }

function createPool(): Pool {
  return new Pool({
    connectionString: env.DATABASE_URL,
    // worker 里 pg-boss 的 transactional handler 会各占一个连接，需要更大的池，
    // 所以允许用 PG_POOL_MAX 覆盖。
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
}

export const pool: Pool = globalForDb.__dressingPool ?? createPool()

if (env.NODE_ENV !== 'production') {
  globalForDb.__dressingPool = pool
}

export const db = drizzle(pool, { schema })

export { schema }
export * from './schema'
