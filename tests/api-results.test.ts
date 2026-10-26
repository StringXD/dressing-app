import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GET } from '@/app/api/results/route'

/**
 * 守的是这个端点**有没有把失败的任务也列出来**。
 *
 * 这是一条涉及钱的契约：`output_download_failed` 这类失败**上游已经生成并计费**，
 * 只是我们没把图下回来。结果区只显示成功的话，用户会以为那次没花钱，
 * 于是放心重试 —— 而重试是要再付一次的。
 *
 * 放在 `tests/` 而不是 `src/app/api/results/` 下：后者是 Next 的 app 路由目录，
 * 往里放非路由文件平白给它增加扫描面。单测一律不连数据库，所以这里两个依赖都桩掉。
 */

const { listRecentResults, getSessionId } = vi.hoisted(() => ({
  listRecentResults: vi.fn<
    (
      sessionId: string,
      options: { limit: number; statuses?: readonly string[] },
    ) => Promise<unknown[]>
  >(async () => []),
  getSessionId: vi.fn<() => Promise<string | null>>(async () => 'sess-1'),
}))

vi.mock('@/lib/session', () => ({ getSessionId }))
vi.mock('@/lib/generation/results', () => ({ listRecentResults }))

describe('GET /api/results', () => {
  beforeEach(() => {
    listRecentResults.mockClear()
    getSessionId.mockResolvedValue('sess-1')
  })

  it('查询必须同时覆盖 succeeded 与 failed', async () => {
    await GET()

    expect(listRecentResults).toHaveBeenCalledTimes(1)
    const [sessionId, options] = listRecentResults.mock.calls[0]

    // 先证明"确实带着会话去查了"。少了这句，下面两条在函数压根没被调用时
    // 会因为读取 undefined 而抛错 —— 那是崩溃，红的原因和想守的东西不是一回事。
    expect(sessionId).toBe('sess-1')

    expect(options.statuses).toContain('failed')
    expect(options.statuses).toContain('succeeded')
  })

  it('limit 是个有限的正整数 —— 防止有人图省事传 Infinity 把整库拉出来', async () => {
    await GET()

    const [, options] = listRecentResults.mock.calls[0]
    expect(Number.isInteger(options.limit)).toBe(true)
    expect(options.limit).toBeGreaterThan(0)
  })

  it('无会话时回空数组，且不查库', async () => {
    getSessionId.mockResolvedValue(null)

    const response = await GET()
    const body = (await response.json()) as unknown

    expect(body).toEqual({ results: [] })
    expect(listRecentResults).not.toHaveBeenCalled()
  })
})
