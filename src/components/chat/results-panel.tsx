'use client'

import { useEffect, useState } from 'react'

import { BeforeAfterSlider } from '@/components/before-after-slider'
import type { CritiqueView } from '@/lib/generation/assessment-labels'

/**
 * 「最近结果」区。
 *
 * 数据源是 `/api/results` 而不是对话流里的工具输出。理由与 `ProgressNotice`
 * 一致：**轮询能扛住刷新页面**。工具输出只存在于客户端消息历史里，刷新即丢失，
 * 而已经生成好的图还在存储里 —— 那种"图明明生成了，界面却说没有"的体验
 * 比多几个请求糟得多。
 */

interface ResultItem {
  generationId: string
  taskKind: 'tryon' | 'hair'
  modelId: string
  status: 'queued' | 'processing' | 'succeeded' | 'failed' | 'canceled'
  costUsd: number | null
  createdAt: string
  imageUrl: string | null
  personImageUrl: string | null
  garmentTitle: string | null
  garmentColor: string | null
  /**
   * 用户问过"这件合身吗"才会有。没问过就是 null —— 这是"问了才评"的体现，
   * 卡片必须能安静地少渲染这块，而不是显示一个空的评价框。
   */
  critique: CritiqueView | null
}

/**
 * 还在变的两个状态。终态之后不再轮询。
 *
 * 抽成导出的纯函数而不是内联在组件里，是因为"什么时候该停"这件事
 * 一旦写错，表现是**无休止轮询**或者**新图永远不出现**，
 * 两种都很难从界面上看出来。这样它可以被单测直接钉住。
 */
export function isActive(status: ResultItem['status']): boolean {
  return status === 'queued' || status === 'processing'
}

/**
 * 够不够渲染对比滑块。
 *
 * 两张图缺一不可。`BeforeAfterSlider` 的 `beforeSrc` / `afterSrc` 是必填字符串，
 * 传 null 进去 TS 会拦下，但从 JSON 来的值绕过了类型 —— 所以这里显式判一次，
 * 并且判的是**真值**而不是 `!== null`：空串会渲染成破图，
 * 或者更糟，浏览器把 `src=""` 当成"重新请求当前页面"。
 */
export function canCompare<
  T extends { imageUrl: string | null; personImageUrl: string | null },
>(item: T): item is T & { imageUrl: string; personImageUrl: string } {
  return Boolean(item.imageUrl && item.personImageUrl)
}

/**
 * 卡片标题上写什么。
 *
 * 优先写**那件衣服是什么**，而不是"换装"两个字 —— 用户回头翻结果时，
 * 认得出"蓝色棒球外套"，认不出"换装"。
 *
 * 抽成纯函数是为了让这条优先顺序可测：识别结果缺失（换发型任务、
 * 或衣服记录已删）时必须退回任务类型，而不是渲染出 "null" 或空白。
 */
export function garmentLabel(item: {
  taskKind: ResultItem['taskKind']
  garmentTitle: string | null
}): string {
  // 换发型任务没有衣服可描述。哪怕数据脏了带上了 title 也不显示 ——
  // 在"换发型"的卡片上写一件外套的款式，只会让用户以为换了件衣服。
  if (item.taskKind === 'hair') return '换发型'

  const title = item.garmentTitle?.trim()
  return title ? title : '换装'
}

const POLL_MS = 3000

interface Props {
  /**
   * 本会话已入队的任务 id。
   *
   * 它变化说明有新任务进来了，需要立刻重拉一次 —— 否则新图要等下一轮轮询
   * 才出现，而用户此刻正盯着屏幕等结果。
   */
  generationIds: string[]
  className?: string
}

export function ResultsPanel({ generationIds, className = '' }: Props) {
  const [items, setItems] = useState<ResultItem[]>([])
  // 区分"还没加载完"和"加载完了但确实没有" —— 两者都渲染成空白的话，
  // 用户看到的是一个说不清是坏了还是没内容的区域。
  const [loaded, setLoaded] = useState(false)

  // 用 join 做依赖而不是数组本身：数组每次渲染都是新引用，会导致无限重拉
  const idsKey = generationIds.join(',')

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function load() {
      try {
        const response = await fetch('/api/results', { cache: 'no-store' })
        if (!response.ok) return

        const body = (await response.json()) as { results?: ResultItem[] }
        if (cancelled) return

        const next = body.results ?? []
        setItems(next)
        setLoaded(true)

        // 只要还有没跑完的就继续追；全到终态就停下来
        if (next.some((item) => isActive(item.status))) {
          timer = setTimeout(load, POLL_MS)
        }
      } catch {
        // 网络抖动不该让界面崩掉，下一次补上
        if (!cancelled) timer = setTimeout(load, POLL_MS)
      }
    }

    void load()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [idsKey])

  return (
    <section className={className}>
      <h2 className="mb-3 text-sm font-medium text-neutral-700 dark:text-neutral-200">
        最近结果
      </h2>

      {!loaded && <p className="text-xs text-neutral-400">正在载入…</p>}

      {loaded && items.length === 0 && (
        <p className="rounded-2xl border border-dashed border-neutral-200 p-4 text-xs text-neutral-400 dark:border-neutral-800">
          还没有生成过。上传一张全身照和一件衣服，在对话里说想试哪件。
        </p>
      )}

      <div className="space-y-4">
        {items.map((item) => (
          <ResultCard key={item.generationId} item={item} />
        ))}
      </div>
    </section>
  )
}

function ResultCard({ item }: { item: ResultItem }) {
  return (
    <article className="rounded-2xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        <span className="font-medium text-neutral-700 dark:text-neutral-200">
          {garmentLabel(item)}
        </span>
        {item.garmentColor && <span>{item.garmentColor}</span>}
        <span>{item.modelId}</span>
        {item.costUsd !== null && <span>${item.costUsd.toFixed(3)}</span>}
        <span>{item.generationId.slice(0, 8)}</span>
      </div>

      {item.status === 'succeeded' && canCompare(item) && (
        <BeforeAfterSlider
          beforeSrc={item.personImageUrl}
          afterSrc={item.imageUrl}
          afterLabel={item.taskKind === 'hair' ? '换发型后' : '换装后'}
        />
      )}

      {/* 成功但缺图：原图被删、或资产已清理。明说，而不是留一片空白 */}
      {item.status === 'succeeded' && !canCompare(item) && (
        <p className="text-xs text-neutral-500">
          这次生成成功了，但对比所需的图片已经不在了（可能已被清理）。
        </p>
      )}

      {isActive(item.status) && (
        <p className="text-xs text-neutral-500">
          {item.status === 'processing' ? '正在生成…' : '排队中…'}
        </p>
      )}

      {item.status === 'failed' && (
        <p className="text-xs text-red-600 dark:text-red-400">
          这次生成失败了。上游可能已经计费，重试前建议先确认。
        </p>
      )}

      {item.status === 'canceled' && (
        <p className="text-xs text-neutral-500">这次生成已取消，没有产生费用。</p>
      )}

      {item.critique && <CritiqueBlock critique={item.critique} />}
    </article>
  )
}

/**
 * 评价那块。
 *
 * 只渲染**确实有内容**的行：`fit` / `color` 缺一个就少一行，
 * 而不是打一行"暂无"。用户在卡片上看到"暂无"会以为评价失败过，
 * 实际只是模型这次没给出这一项。
 */
function CritiqueBlock({ critique }: { critique: CritiqueView }) {
  const { fit, color, highlights, suggestions } = critique

  return (
    <div className="mt-3 space-y-1.5 rounded-xl bg-neutral-50 p-2.5 dark:bg-neutral-800/60">
      {fit && (
        <p className="text-xs text-neutral-600 dark:text-neutral-300">
          <span className="font-medium">合身度</span> · {fit}
        </p>
      )}
      {color && (
        <p className="text-xs text-neutral-600 dark:text-neutral-300">
          <span className="font-medium">配色</span> · {color}
        </p>
      )}

      {highlights.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-neutral-600 dark:text-neutral-300">
          {highlights.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      {suggestions.length > 0 && (
        <div className="pt-0.5">
          <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">可以试试</p>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-neutral-500">
            {suggestions.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
