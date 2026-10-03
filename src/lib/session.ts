import { cookies } from 'next/headers'

import { db } from '@/lib/db'
import { sessions } from '@/lib/db/schema'

/**
 * 匿名会话。第一版不做登录 —— 用 cookie 里的随机 ID 区分用户，
 * 数据隔离与配额都挂在它上面。后续加登录时，只需给 sessions 表挂 userId，
 * 业务表（assets/garments/generations）全部通过 sessionId 间接关联，无需改动。
 */
const COOKIE_NAME = 'dressing_sid'
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365

/** 只读会话 ID，不创建。用于 GET 类请求，避免读操作产生副作用。 */
export async function getSessionId(): Promise<string | null> {
  const jar = await cookies()
  return jar.get(COOKIE_NAME)?.value ?? null
}

/**
 * 取会话 ID，没有就创建。
 *
 * ⚠️ 只能在 Route Handler 或 Server Action 中调用 ——
 * `cookies().set()` 在 Server Component 里会抛错。
 */
export async function requireSessionId(): Promise<string> {
  const jar = await cookies()
  const existing = jar.get(COOKIE_NAME)?.value

  if (existing) {
    await touchSession(existing)
    return existing
  }

  const id = crypto.randomUUID()

  jar.set(COOKIE_NAME, id, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ONE_YEAR_SECONDS,
    secure: process.env.NODE_ENV === 'production',
  })

  await touchSession(id)
  return id
}

/**
 * 建行或刷新 lastSeenAt，一次 upsert 同时覆盖两种情况。
 *
 * 代价是每个 API 请求一次小写入 —— 在 demo 规模下完全不是瓶颈，
 * 换来的是 lastSeenAt 始终准确。若将来 QPS 上来了，改成"仅缺失时插入 + 定时批量刷新"即可。
 *
 * onConflictDoUpdate 也顺带覆盖了"数据库被重置但客户端仍持有旧 cookie"的情况，
 * 否则外键会直接报错。
 */
async function touchSession(id: string): Promise<void> {
  await db
    .insert(sessions)
    .values({ id })
    .onConflictDoUpdate({
      target: sessions.id,
      set: { lastSeenAt: new Date() },
    })
}
