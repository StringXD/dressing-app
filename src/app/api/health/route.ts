import { sql } from 'drizzle-orm'

import { db } from '@/lib/db'

/**
 * 健康检查。刻意真的打一次数据库而不是只返回 200 ——
 * 只回 200 的话，数据库挂了它照样是绿的，就失去意义了。
 *
 * GET 处理器里访问数据库会让该路由自动变为动态渲染，无需额外声明。
 */
export async function GET() {
  const startedAt = Date.now()

  try {
    await db.execute(sql`select 1`)

    return Response.json({
      ok: true,
      db: 'up',
      latencyMs: Date.now() - startedAt,
    })
  } catch (error) {
    return Response.json(
      {
        ok: false,
        db: 'down',
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    )
  }
}
