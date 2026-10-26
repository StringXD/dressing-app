'use client'

import { useEffect, useState } from 'react'

import { BATCH_TRYON_MAX } from '@/lib/domain'
import { formatAttachmentLine, formatGarmentSelectionLine } from '@/lib/chat/annotations'

interface PersonItem {
  assetId: string
  url: string
  uploadedAt: string
}

interface GarmentItem {
  garmentId: string
  assetId: string
  url: string
  title: string | null
  color: string | null
  photoType: string
}

interface WorkbenchItems {
  people: PersonItem[]
  garments: GarmentItem[]
}

interface Props {
  /**
   * 提交。由 `ChatPanel` 注入 —— 网格**自己不发消息、也不碰入队**。
   *
   * 这是刻意的：`enqueueGeneration()` 是唯一入队路径，网格要是自己发一个请求
   * 把任务塞进队列，花费闸门就有了第二份实现，而那是这个项目里最不能
   * 有副本的东西。它只负责把选中项编成文本。
   */
  onSubmit: (text: string) => void
  /** 单张价格，用于在提交前把总价说清楚。取不到时为 null，此时不显示金额 */
  tryOnCostUsd?: number | null
  disabled?: boolean
}

/**
 * 把选中项编成交给模型的那条消息。
 *
 * 抽成纯函数（不依赖 React）是为了让"哪个 id 写进了哪一行"能被单测直接看着 ——
 * 与 `attachments.ts` 同一条理由：编错了不会报错，只会让模型找不到东西，
 * 或者更糟：拿 assetId 当 garmentId 用，然后说"找不到这件衣服"。
 */
export function formatWorkbenchSelection(personAssetIds: string[], garmentIds: string[]): string {
  return [
    '按工作台选好的素材批量试穿，请原样使用下面这些 id：',
    ...personAssetIds.map((assetId) => formatAttachmentLine({ assetId, kind: 'person' })),
    ...garmentIds.map(formatGarmentSelectionLine),
  ].join('\n')
}

/**
 * 工作台：把素材摆成网格，多选之后交给对话去试。
 *
 * 展开时才拉清单 —— 没打算用工作台的人不该为它付一次请求。
 */
export function WorkbenchGrid({ onSubmit, tryOnCostUsd = null, disabled = false }: Props) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<WorkbenchItems | null>(null)
  const [failed, setFailed] = useState(false)
  const [people, setPeople] = useState<string[]>([])
  const [garments, setGarments] = useState<string[]>([])

  useEffect(() => {
    if (!open || items) return

    let cancelled = false

    fetch('/api/workbench', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status))
        return response.json() as Promise<WorkbenchItems>
      })
      .then((body) => {
        if (!cancelled) setItems(body)
      })
      .catch(() => {
        // 清单读不到不该把整个对话页弄坏 —— 它只是工作台用不了
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
    }
  }, [open, items])

  // 人物照 × 服装是**乘法**：这个数字就是将要花掉的钱，必须在发送前算出来
  const total = people.length * garments.length
  const overCap = total > BATCH_TRYON_MAX

  function toggle(list: string[], setList: (next: string[]) => void, id: string) {
    setList(list.includes(id) ? list.filter((item) => item !== id) : [...list, id])
  }

  function submit() {
    onSubmit(formatWorkbenchSelection(people, garments))
    setOpen(false)
  }

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full px-3 py-2 text-left text-sm text-neutral-600 dark:text-neutral-300"
      >
        {open ? '收起工作台' : '打开工作台（挑素材批量试）'}
      </button>

      {open && (
        <div className="space-y-3 border-t border-neutral-200 px-3 py-3 dark:border-neutral-800">
          {failed && <p className="text-sm text-red-600">没能读到你的素材，稍后再试。</p>}

          {!failed && !items && <p className="text-sm text-neutral-500">正在读取素材…</p>}

          {items && items.people.length === 0 && items.garments.length === 0 && (
            <p className="text-sm text-neutral-500">
              还什么都没有。先上传一张全身照、再传一件衣服让它认一下。
            </p>
          )}

          {items && items.people.length > 0 && (
            <Section title="人物照">
              {items.people.map((person) => (
                <Tile
                  key={person.assetId}
                  url={person.url}
                  label="人物照"
                  selected={people.includes(person.assetId)}
                  onToggle={() => toggle(people, setPeople, person.assetId)}
                />
              ))}
            </Section>
          )}

          {items && items.garments.length > 0 && (
            <Section title="服装">
              {items.garments.map((garment) => (
                <Tile
                  key={garment.garmentId}
                  url={garment.url}
                  label={garment.title ?? '未命名'}
                  selected={garments.includes(garment.garmentId)}
                  onToggle={() => toggle(garments, setGarments, garment.garmentId)}
                />
              ))}
            </Section>
          )}

          {items && (items.people.length > 0 || items.garments.length > 0) && (
            <div className="space-y-1">
              <p className="text-sm text-neutral-600 dark:text-neutral-300">
                {people.length} 张人物照 × {garments.length} 件衣服 = {total} 张
                {tryOnCostUsd !== null && total > 0
                  ? ` · 约 $${(total * tryOnCostUsd).toFixed(3)}`
                  : ''}
              </p>

              {/*
                * 在**发送之前**就把超限说出来。让工具事后拒绝也能拦住花钱，
                * 但用户会先读完一整轮对话才发现自己白选了 —— 而且模型可能
                * 自作主张地删掉几个来"修好"它，那就变成了另一种结果。
                */}
              {overCap && (
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  一次最多 {BATCH_TRYON_MAX} 张，现在这个组合是 {total} 张。少选几件。
                </p>
              )}

              <button
                type="button"
                onClick={submit}
                disabled={total === 0 || overCap || disabled}
                className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
              >
                按这个组合试穿
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-neutral-500">{title}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )
}

function Tile({
  url,
  label,
  selected,
  onToggle,
}: {
  url: string
  label: string
  selected: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      // 选中状态用 aria-pressed 表达，而不是只靠边框颜色 ——
      // 后者在单测里没法断言，色弱用户也看不出来
      aria-pressed={selected}
      title={label}
      className={`overflow-hidden rounded-lg border-2 ${
        selected ? 'border-neutral-900 dark:border-neutral-100' : 'border-transparent'
      }`}
    >
      {/*
        用原生 img 而不是 next/image，与 `before-after-slider` / `upload-dropzone` 同理：
        这些图由 `/api/files` 直接提供，尺寸早已在上传时归一化过，
        走 next/image 的优化管线反而要额外配置 remotePatterns。
      */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={label} className="h-20 w-20 object-cover" />
    </button>
  )
}
