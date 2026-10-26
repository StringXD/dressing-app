'use client'

import { BeforeAfterSlider } from '@/components/before-after-slider'

/**
 * UI 层工具调用的结构化视图。
 *
 * 这里刻意用宽松的结构类型而不是 SDK 的 `ToolUIPart` 泛型：那套泛型是为
 * "工具集类型已知"的场景设计的，而我们的工具集是在服务端装配的，
 * 客户端只知道 `type` 是 `tool-<名字>`。硬套泛型只会换来一堆断言，
 * 换不到任何真实的类型安全。
 */
export interface ToolPartLike {
  type: string
  toolCallId: string
  state: string
  input?: unknown
  output?: unknown
  errorText?: string
  approval?: { id: string; approved?: boolean; reason?: string }
}

export function isToolPart(part: { type: string }): part is { type: string } & ToolPartLike {
  return part.type.startsWith('tool-')
}

/** `tool-enqueueTryOn` → `enqueueTryOn` */
export function toolNameOf(part: { type: string }): string {
  return part.type.slice('tool-'.length)
}

const TOOL_LABELS: Record<string, string> = {
  identifyGarment: '识别服装',
  confirmPlan: '生成计划',
  enqueueTryOn: '发起换装生成',
  enqueueHairChange: '发起换发型生成',
  batchTryOn: '批量试穿',
  getQueueStatus: '查询队列',
  listRecentResults: '最近的结果',
  listRecentPhotos: '你传过的照片',
  inspectPhoto: '照片检查',
  getCostSummary: '花费统计',
  critiqueOutfit: '结果评价',
  analyzeBodyShape: '体型分析',
  analyzeColorSeason: '色彩季型',
  suggestStyle: '风格建议',
  cloneLook: '整套提取',
  cropGarment: '按件裁图',
  compareResults: '结果对比',
}

/**
 * 花钱的工具。
 *
 * 与 `src/lib/agent/tools.ts` 的 `SPENDING_TOOL_APPROVAL` 是**同一份名单的两种表达**：
 * 那边决定服务端要不要拦，这边决定界面要不要把"要花钱"说醒目。
 * 两边都必须有，因为服务端拦住之后用户还得知道自己在批准什么。
 */
const SPENDING_TOOLS = new Set(['enqueueTryOn', 'enqueueHairChange', 'batchTryOn'])

interface Props {
  part: ToolPartLike
  onApproval: (approvalId: string, approved: boolean) => void
  /** 人物照地址，用于对比滑块的原图一侧 */
  personImageUrl?: string | null
  /**
   * 试穿单张的价格，用于在**审批之前**算出批量试穿要花多少钱。
   * 由服务端传入（见 `describeTryOnCost`）—— 界面自己存一份价格必然会漂移。
   */
  tryOnCostUsd?: number | null
  className?: string
}

function summarize(tool: string, input: unknown, costPerRun: number | null): string | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>

  if (tool === 'enqueueTryOn') {
    const parts = [
      record.category && record.category !== 'auto' ? `品类：${record.category}` : null,
      record.mode ? `档位：${record.mode}` : null,
    ].filter(Boolean)
    return parts.join(' · ') || null
  }

  if (tool === 'enqueueHairChange') {
    return [record.hairstyle, record.color].filter(Boolean).join(' · ') || null
  }

  if (tool === 'confirmPlan') {
    return typeof record.summary === 'string' ? record.summary : null
  }

  if (tool === 'batchTryOn') {
    return batchTryOnDetail(record, costPerRun)
  }

  return null
}

/**
 * 批量试穿的审批摘要 —— **张数与预估总额**，不是一个"会花钱"的形容词。
 *
 * 用户批准的不该是一句笼统的警告，而是一个能自己核对的数字：
 * 他给的人物照张数与衣服件数相乘，就是将要发生的调用次数。
 * 只写"会花钱"的话，8 张 $0.6 与 1 张 $0.075 在界面上长得一模一样。
 *
 * 抽成独立导出是为了能直接单测：审批卡片上最容易错的不是样式，
 * 而是这个乘法 —— 没有它，卡片会把 `personAssetIds × garmentIds`
 * 显示成其中一个数组的长度，看起来完全正常。
 */
export function batchTryOnDetail(
  input: Record<string, unknown>,
  costPerRun: number | null,
): string | null {
  const count = countBatchPairs(input)
  if (count === null) return null

  const parts = [`${count} 张`]

  const category = input.category
  if (typeof category === 'string' && category !== 'auto') parts.push(`品类：${category}`)

  const mode = input.mode
  if (typeof mode === 'string' && mode !== 'balanced') parts.push(`档位：${mode}`)

  if (costPerRun !== null) {
    parts.push(`预计 $${(costPerRun * count).toFixed(3)}`)
  }

  return parts.join(' · ')
}

/**
 * 人物照与衣服的配对数量。
 *
 * **按去重后的数量相乘**，与服务端 `batchTryOn` 的口径一致：
 * 模型传 ['a','a'] 时真实只会生成 1 组，卡片若按入参长度显示 2 张，
 * 用户批准的数字就与实际扣费不符 —— 那是这张卡片最不该犯的错。
 *
 * 参数缺失或不是数组时返回 null（卡片退回到只显示工具名），
 * 而不是返回 0：0 张是一个看起来很确定的错误数字。
 */
export function countBatchPairs(input: Record<string, unknown>): number | null {
  const persons = input.personAssetIds
  const garments = input.garmentIds

  if (!Array.isArray(persons) || !Array.isArray(garments)) return null
  if (persons.length === 0 || garments.length === 0) return null

  return new Set(persons).size * new Set(garments).size
}

/**
 * 一个工具调用的卡片。
 *
 * 分两种形态：**花钱的**要有醒目的成本提示与审批按钮，**不花钱的**只展示结果。
 * 把所有工具渲染成一模一样的灰卡片，用户就分不清哪一下会扣钱。
 */
export function ToolCard({
  part,
  onApproval,
  personImageUrl,
  tryOnCostUsd = null,
  className = '',
}: Props) {
  const tool = toolNameOf(part)
  const label = TOOL_LABELS[tool] ?? tool
  const spending = SPENDING_TOOLS.has(tool)
  const detail = summarize(tool, part.input, tryOnCostUsd)

  const output = (part.output ?? null) as Record<string, unknown> | null
  const cost =
    typeof output?.costUsd === 'number' ? (output.costUsd as number) : null
  const planCost =
    typeof (part.input as Record<string, unknown> | null)?.estimatedCostUsd === 'number'
      ? ((part.input as Record<string, unknown>).estimatedCostUsd as number)
      : null

  return (
    <div
      className={`rounded-2xl border p-3 text-sm ${
        spending
          ? 'border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/40'
          : 'border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900'
      } ${className}`}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium text-neutral-700 dark:text-neutral-200">{label}</span>
        {spending && (
          <span className="rounded-full bg-amber-200/70 px-2 py-0.5 text-[11px] font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-200">
            会花钱
          </span>
        )}
        <StatusDot state={part.state} />
      </div>

      {detail && <p className="mt-1 text-xs text-neutral-500">{detail}</p>}

      {planCost !== null && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
          预计花费 ${planCost.toFixed(3)}
        </p>
      )}

      {/* ── 审批：整个应用里唯一会真正花钱的那一道门 ─────────────── */}
      {part.state === 'approval-requested' && part.approval && (
        <div className="mt-3">
          <p className="text-xs text-neutral-600 dark:text-neutral-300">
            确认要执行吗？确认后会真实调用上游模型并产生费用。
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => onApproval(part.approval!.id, true)}
              className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              确认生成
            </button>
            <button
              type="button"
              onClick={() => onApproval(part.approval!.id, false)}
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              先不要
            </button>
          </div>
        </div>
      )}

      {part.state === 'approval-responded' && part.approval && (
        <p className="mt-2 text-xs text-neutral-500">
          {part.approval.approved ? '你已确认，正在执行…' : '你取消了这次生成，没有产生费用。'}
        </p>
      )}

      {/* ── 结果 ─────────────────────────────────────────────── */}
      {part.state === 'output-available' && output && (
        <ToolOutput
          tool={tool}
          output={output}
          cost={cost}
          personImageUrl={personImageUrl}
        />
      )}

      {part.state === 'output-error' && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">
          {part.errorText ?? '这一步失败了'}
        </p>
      )}
    </div>
  )
}

function StatusDot({ state }: { state: string }) {
  const running = state === 'input-streaming' || state === 'input-available'
  if (!running) return null
  return <span className="text-[11px] text-neutral-400">处理中…</span>
}

/**
 * 裁出来的衣服缩略图。
 *
 * 用原生 img 而不是 next/image，与 `workbench-grid` / `before-after-slider` 同理：
 * 这些图由 `/api/files` 直接提供，尺寸在裁切时就已经定死，走 next/image 的
 * 优化管线反而要额外配置 remotePatterns。
 */
function CropThumbnail({ url, alt }: { url: string; alt: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={alt} className="h-20 w-20 rounded object-cover" />
  )
}

function ToolOutput({
  tool,
  output,
  cost,
  personImageUrl,
}: {
  tool: string
  output: Record<string, unknown>
  cost: number | null
  personImageUrl?: string | null
}) {
  /*
   * 裁图的结果**必须把图显示出来**：这个工具的全部价值就是让用户看到
   * "这几件被单独拎出来了，可以直接拿去试"。只报"已裁出 3 件"的话，
   * 框裁歪了的那些要等他花钱试穿一次才会发现。
   */
  if (tool === 'cropGarment') {
    const created = Array.isArray(output.created) ? output.created : []
    const skipped = Array.isArray(output.skipped) ? output.skipped : []

    return (
      <div className="mt-2 space-y-2">
        {created.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {created.map((item) => {
              const row = item as Record<string, unknown>
              const imageUrl = typeof row.imageUrl === 'string' ? row.imageUrl : null
              const title = String(row.title)

              return (
                <figure key={String(row.garmentId)} className="w-20">
                  {imageUrl ? (
                    <CropThumbnail url={imageUrl} alt={title} />
                  ) : (
                    <div className="h-20 w-20 rounded bg-neutral-100 dark:bg-neutral-800" />
                  )}
                  <figcaption className="mt-1 truncate text-[11px] text-neutral-500" title={title}>
                    {title}
                  </figcaption>
                </figure>
              )
            })}
          </div>
        )}

        <p className="text-xs text-neutral-600 dark:text-neutral-300">
          裁出 {created.length} 件，已放进衣橱。
          {/*
            跳过的那几件**指名道姓地说出来**：模型可能在回复里带过一句，
            但用户真正会看的是卡片。不说的话他会去衣橱里找一件不存在的衣服。
          */}
          {skipped.length > 0 && (
            <span className="text-amber-600 dark:text-amber-500">
              {' '}
              另有 {skipped.length} 件没裁成（
              {skipped.map((item) => String((item as Record<string, unknown>).title)).join('、')}
              ）—— 这张图里它们的位置没框准，单件重传一张会更稳。
            </span>
          )}
        </p>
      </div>
    )
  }

  if (tool === 'identifyGarment') {
    return (
      <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">
        识别为「{String(output.title)}」，主色 {String(output.color)}。
      </p>
    )
  }

  if (tool === 'enqueueTryOn' || tool === 'enqueueHairChange') {
    return (
      <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">
        已入队，任务 {String(output.generationId).slice(0, 8)}
        {cost !== null && ` · 本次花费 $${cost.toFixed(3)}`}
      </p>
    )
  }

  if (tool === 'listRecentResults') {
    const results = Array.isArray(output.results) ? output.results : []
    if (results.length === 0) {
      return <p className="mt-2 text-xs text-neutral-500">还没有成功过的生成结果。</p>
    }

    return (
      <div className="mt-2 space-y-3">
        {results.slice(0, 3).map((item) => {
          const row = item as Record<string, unknown>
          const imageUrl = typeof row.imageUrl === 'string' ? row.imageUrl : null
          const personUrl = personImageUrl ?? null

          // 有原图才给对比滑块 —— 只有结果图时并排对比没有意义
          if (imageUrl && personUrl) {
            return (
              <BeforeAfterSlider
                key={String(row.generationId)}
                beforeSrc={personUrl}
                afterSrc={imageUrl}
                afterLabel={row.taskKind === 'hair' ? '换发型后' : '换装后'}
              />
            )
          }

          return (
            <p key={String(row.generationId)} className="text-xs text-neutral-500">
              {String(row.generationId).slice(0, 8)} · {String(row.modelId)}
            </p>
          )
        })}
      </div>
    )
  }

  return null
}
