import { listWorkbenchItems } from '@/lib/generation/workbench'
import { getSessionId } from '@/lib/session'

/**
 * 工作台的素材清单：能选的人物照与服装。
 *
 * 只读，不创建会话 —— GET 不该有副作用（同 `/api/queue`）。
 * 无会话时给空清单而不是 401：对一个还没传过任何东西的访客来说，
 * 工作台本来就该是空的，报错反而像是坏了。
 *
 * ⚠️ **这个端点不接收入队请求，也不该有人给它加一个。**
 * 网格里选中若干项之后，提交走的是对话：`enqueueGeneration()` 是唯一入队路径
 * （见铁律 2），多开一条就多一处要同步归属校验、参数校验与花费闸门的地方 ——
 * 而花费闸门正是这个项目里最不能有第二份实现的东西。
 */
export async function GET() {
  const sessionId = await getSessionId()

  if (!sessionId) {
    return Response.json(
      { people: [], garments: [] },
      { headers: { 'cache-control': 'no-store' } },
    )
  }

  const items = await listWorkbenchItems(sessionId)

  // 用户随时会上传新图或认出新服装，缓存会让人以为上传没生效
  return Response.json(items, { headers: { 'cache-control': 'no-store' } })
}
