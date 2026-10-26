'use client'

import { useEffect, useState } from 'react'

type CostImpact = 'none' | 'charged' | 'unknown'

interface QueueItem {
  id: string
  status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'canceled'
  position: number
  active: boolean
  error?: { title: string; action: string; cost: CostImpact }
  /** 入队时刻。只有"会话里全部未结束的任务"那种形态才带 */
  createdAt?: string
}

interface Props {
  /** 本次对话已经入队的任务 */
  generationIds: string[]
  className?: string
}

/**
 * 生成进度与失败原因。
 *
 * 数据源是已有的 `/api/queue`，而不是流里的 transient data part。理由：
 *
 * 1. 失败原因（`error.title` / `error.action` / `error.cost`）本来就是那个端点算出来的，
 *    它的映射逻辑在 `generation/errors.ts` 里，是纯函数且有单测。再接一条链路
 *    推送同样的信息，等于把同一件事实现两遍。
 * 2. 轮询**能扛住刷新页面**。流式推送在用户刷新后就断了，而任务还在跑 ——
 *    那时界面会显示成"什么都没发生"，这比多几个请求糟得多。
 *
 * 终态任务不再计入轮询条件：`active` 由服务端给出，前端不自己判断状态机。
 */
const POLL_MS = 2000

export function ProgressNotice({ generationIds, className = '' }: Props) {
  // 结果连同它属于哪批 id 一起存。切换任务集时旧结果靠 key 不匹配自然失效，
  // 因此不需要在 effect 里同步 setState 去"清空"—— 那会触发一次级联渲染。
  const [polled, setPolled] = useState<{
    key: string
    active: QueueItem[]
    failed: QueueItem[]
  }>({ key: '', active: [], failed: [] })

  // 用 join 做依赖而不是数组本身：数组每次渲染都是新引用，会导致无限轮询
  const idsKey = generationIds.join(',')

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    // 没有 id **不等于**没事发生：刷新之后这里必然是空的，而任务还在跑。
    // 所以照样去问服务端一次 —— 这正是那个缺口所在，也是上面那句
    // "轮询能扛住刷新"真正成立的条件（在此之前，它只是一句好听的注释）。
    const url = idsKey ? `/api/queue?ids=${encodeURIComponent(idsKey)}` : '/api/queue'

    async function poll() {
      try {
        const response = await fetch(url, { cache: 'no-store' })
        if (!response.ok) return

        const body = (await response.json()) as { items?: QueueItem[]; active?: QueueItem[] }
        if (cancelled) return

        // 两批数据回答的是不同问题，所以并列而不是二选一：
        // "在跑什么"来自服务端（刷新后仍然知道），"为什么失败"来自按 id 查的那批
        // （只有客户端还记得 id 的任务才解释得了）
        const nextActive = body.active ?? []
        const nextFailed = (body.items ?? []).filter((item) => item.status === 'failed')
        setPolled({ key: idsKey, active: nextActive, failed: nextFailed })

        // 只要还有会变的任务就继续轮询；全部到终态就停下来。
        // 两个条件都写上不是冗余：`active` 有上限，任务特别多时自己关心的那个
        // 可能被截断掉，那时就只能靠 items 里自己的状态来决定要不要继续问
        const stillRunning =
          nextActive.some((item) => item.active) ||
          (body.items ?? []).some((item) => item.active)

        if (stillRunning) {
          timer = setTimeout(poll, POLL_MS)
        }
      } catch {
        // 网络抖动不该让界面崩掉，下一次轮询会补上
        if (!cancelled) timer = setTimeout(poll, POLL_MS)
      }
    }

    void poll()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [idsKey])

  const { active, failed } = polled.key === idsKey ? polled : { active: [], failed: [] }

  if (active.length === 0 && failed.length === 0) return null

  return (
    <div className={`space-y-2 ${className}`}>
      {active.length > 0 && (
        <div className="rounded-2xl border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
          <p className="font-medium text-neutral-700 dark:text-neutral-200">
            正在生成 {active.length} 个任务
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-neutral-500">
            {active.map((item) => (
              <li key={item.id}>
                {item.id.slice(0, 8)} ·{' '}
                {item.status === 'processing'
                  ? '生成中'
                  : item.position > 0
                    ? `前面还有 ${item.position} 个`
                    : '排队中'}
                {waitedNote(item.createdAt)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {failed.map((item) => (
        <div
          key={item.id}
          className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950/50"
        >
          <p className="font-medium text-red-800 dark:text-red-200">
            {item.error?.title ?? '这次生成失败了'}
          </p>
          {item.error?.action && (
            <p className="mt-1 text-xs text-red-700 dark:text-red-300">{item.error.action}</p>
          )}
          <p className="mt-1 text-[11px] text-red-600/80 dark:text-red-400/80">
            {costNote(item.error?.cost)}
          </p>
        </div>
      ))}
    </div>
  )
}

/**
 * 这次失败有没有花钱。
 *
 * 三态而不是布尔：`unknown` 必须如实说"不确定"。把一次可能已经计费的失败
 * 说成"没花钱"，比不说更糟 —— 用户会据此决定要不要重试。
 */
function costNote(cost: CostImpact | undefined): string {
  if (cost === 'charged') return '这次已经计费（上游图已生成）'
  if (cost === 'none') return '这次没有产生费用'
  return '是否已计费无法确定，建议先查账单再重试'
}

/**
 * "已经等了多久"，给不出时返回空串。
 *
 * 队位说的是"排第几"，这句话说的是"是不是卡住了" —— 后者才是刷新页面
 * 回来的人真正想知道的。没有入队时刻（按 id 查的那种形态）时不必硬凑。
 *
 * `now` 可注入是为了能测：用 `Date.now()` 的话，断言里就只能写
 * "大约"，那种测试在变红之前先会随机变绿。
 */
export function waitedNote(createdAt: string | undefined, now = Date.now()): string {
  if (!createdAt) return ''

  const startedAt = new Date(createdAt).getTime()
  if (Number.isNaN(startedAt)) return ''

  const seconds = Math.floor((now - startedAt) / 1000)
  // 时钟漂移或未来时间戳：宁可不说，也不要显示"-3 秒"
  if (seconds < 0) return ''

  if (seconds < 60) return ` · 已等 ${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return ` · 已等 ${minutes} 分钟`
  return ` · 已等 ${Math.floor(minutes / 60)} 小时`
}
