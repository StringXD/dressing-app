'use client'

import { useChat } from '@ai-sdk/react'
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type UIMessage,
} from 'ai'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'

import { UploadDropzone, type UploadedAsset } from '@/components/upload-dropzone'

import { ProgressNotice } from './progress-notice'
import { ResultsPanel } from './results-panel'
import { WorkbenchGrid } from './workbench-grid'
import { ToolCard, isToolPart } from './tool-card'
import {
  formatAttachmentLine,
  parseAttachmentLines,
  stripAnnotationLines,
} from '@/lib/chat/annotations'

/**
 * 对话面板。
 *
 * 关于**附件怎么进对话**：不把图片字节塞进消息，而是把 `assetId` 以一行
 * 机器可读的标注写进文本，由 Agent 拿着 id 去调 `identifyGarment`。
 * 原因是 context：视觉部分由 `identifyGarment` 单独发起一次调用，
 * 只把结论留在对话历史里。多步循环里反复带上原图会让 token 迅速膨胀
 * （实测单图 input_tokens 已 1356）。
 *
 * 标注的编解码在 `./attachments`，有单测钉着往返。
 */

/** 读回一次对话时的响应形状，与服务端 `loadConversation` 对齐 */
interface StoredConversation {
  id: string
  title: string | null
  messages: UIMessage[]
}

export function ChatPanel({
  tryOnCostUsd = null,
  conversationId,
}: {
  tryOnCostUsd?: number | null
  /** 这次对话的 id。由页面从 URL 里取，没有就新生成一个（见 `app/chat/page.tsx`） */
  conversationId: string
}) {
  const router = useRouter()

  /**
   * transport 里要带上 conversationId。
   *
   * 用 `useMemo` 按 id 重建，而不是拿 ref 传值：
   * - 在**渲染期间写 ref** 本身是错的。并发渲染下它可能读到一个不该看到的旧值，
   *   eslint 的 `react-hooks/refs` 会直接报错（这条就是这么被发现的）。
   * - 用 `useState` 的初始化器则只跑一次，会把 id 钉死在首帧 ——
   *   之后 id 变了也不会跟着变，而且**不会报错**，正是本项目最怕的那类失败。
   */
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        prepareSendMessagesRequest: ({ messages, body }) => ({
          body: { ...body, messages, conversationId },
        }),
      }),
    [conversationId],
  )

  const { messages, sendMessage, setMessages, status, error, addToolApprovalResponse } = useChat({
    transport,
    /**
     * ⚠️ 这一行是审批链路能走通的**唯一**保证，去掉它界面照样显示"你已确认"，
     * 但回执永远发不出去 —— 工具体不执行，用户以为批准了，其实什么都没发生。
     *
     * ai@7 内部在 `addToolApprovalResponse` 里写的是
     * `if (... && this.sendAutomaticallyWhen) this.shouldSendAutomatically()...`，
     * 没传这个回调时守卫直接短路，`makeRequestForToolApproval` 根本不会被调用。
     * 不传不会报错、不会警告，只会静默失败，所以必须有测试钉着。
     */
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,

    /**
     * 每轮结束后让服务端重渲染一次。
     *
     * 上面的历史列表是**服务端渲染的快照**（见 `conversation-list.tsx`）。
     * 第一句话发出去之后这次对话才在库里存在、标题也是那一刻才写下的，
     * 不重渲染的话用户发完第一句话会在历史里找不到它 —— 看起来像丢了。
     */
    onFinish: () => router.refresh(),
  })

  /*
   * 把 id 钉进地址栏。
   *
   * 刷新时页面会带着同一个 id 重新渲染，下面的读回逻辑才找得到这次对话。
   * 没有这一步，id 只活在内存里 —— 刷新后客户端拿到一个新 id，
   * 数据虽然在库里，却没有任何东西指向它。
   *
   * replace 而不是 push：这不该在后退栈里加一格。用户按后退是想回上一页，
   * 不是回到"这个地址少一个参数的自己"。
   */
  useEffect(() => {
    // 地址栏里已经是它了就不必再跳（刷新时会走到这里），省一趟 RSC 请求
    if (new URLSearchParams(window.location.search).get('c') === conversationId) return
    router.replace(`/chat?c=${conversationId}`)
  }, [router, conversationId])

  /*
   * 读回历史消息，**每次 conversationId 变化时一次**。
   *
   * 不能每轮都重拉：那会把 useChat 正在流式写入的消息覆盖掉。
   * 所以依赖只有 id，没有 messages / status。
   *
   * 读不回来（404、网络抖动）就当这次没有历史 —— 一个空对话仍然能用，
   * 而为此把整页弄成错误提示是更差的结果。
   */
  useEffect(() => {
    let cancelled = false

    fetch(`/api/conversations/${conversationId}`, { cache: 'no-store' })
      .then((response) => (response.ok ? (response.json() as Promise<StoredConversation>) : null))
      .then((stored) => {
        if (cancelled || !stored || stored.messages.length === 0) return
        setMessages(stored.messages)
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [conversationId, setMessages])

  const [text, setText] = useState('')
  const [person, setPerson] = useState<UploadedAsset | null>(null)
  const [garments, setGarments] = useState<UploadedAsset[]>([])
  const formRef = useRef<HTMLFormElement>(null)

  const busy = status === 'submitted' || status === 'streaming'

  /** 本次会话里已入队的任务 —— 交给进度面板去轮询 */
  const generationIds = useMemo(() => {
    const ids = new Set<string>()
    for (const message of messages) {
      for (const part of message.parts) {
        if (!isToolPart(part) || part.state !== 'output-available') continue
        const output = part.output as Record<string, unknown> | null
        if (typeof output?.generationId === 'string') ids.add(output.generationId)
      }
    }
    return [...ids]
  }, [messages])

  /** 最近一次上传的人物照，用于对比滑块的原图一侧 */
  const personUrl = person?.url ?? null

  function submit(event: React.FormEvent) {
    event.preventDefault()

    const typed = text.trim()
    const attachments = [
      ...(person ? [{ assetId: person.id, url: person.url, kind: 'person' as const }] : []),
      ...garments.map((asset) => ({ assetId: asset.id, url: asset.url, kind: 'garment' as const })),
    ]

    if (!typed && attachments.length === 0) return

    const lines = [
      typed,
      ...attachments.map(formatAttachmentLine),
    ].filter(Boolean)

    sendMessage({ text: lines.join('\n') })

    setText('')
    setGarments([])
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-3">
        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            personUrl={personUrl}
            tryOnCostUsd={tryOnCostUsd}
            onApproval={(approvalId, approved) =>
              addToolApprovalResponse({ id: approvalId, approved })
            }
          />
        ))}
      </div>

      <ProgressNotice generationIds={generationIds} />

      {/*
        「最近结果」放在消息流之下、表单之上：它是这一轮对话的产出，
        但不是某一条消息的附属物 —— 它的数据源是生成任务表，与消息各活各的
        （消息只读回最近若干条，更早的结果仍在）。
      */}
      <ResultsPanel generationIds={generationIds} className="mt-2" />

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
          对话出错了：{error.message}
        </div>
      )}

      {/*
        工作台放在表单之上、结果之下：它是**输入**侧的辅助，
        选了之后走的是同一个 sendMessage —— 网格不自己入队。
      */}
      <WorkbenchGrid
        tryOnCostUsd={tryOnCostUsd}
        disabled={busy}
        onSubmit={(text) => sendMessage({ text })}
      />

      <form
        ref={formRef}
        onSubmit={submit}
        className="rounded-2xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <UploadDropzone
            label="人物照"
            hint="选一张全身照（只取第一张）"
            onUploaded={(assets) => setPerson(assets[0] ?? null)}
          />
          <UploadDropzone
            label="服装图"
            hint="可多选，衣服平铺图或商品页截图都行"
            multiple
            onUploaded={(assets) => setGarments((prev) => [...prev, ...assets])}
          />
        </div>

        {garments.length > 0 && (
          <ul className="mb-3 flex flex-wrap gap-2">
            {garments.map((asset) => (
              <li key={asset.id} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={asset.url}
                  alt="待试穿的服装"
                  className="size-14 rounded-lg border border-neutral-200 object-cover dark:border-neutral-700"
                />
                <button
                  type="button"
                  aria-label="移除这件服装"
                  onClick={() => setGarments((prev) => prev.filter((a) => a.id !== asset.id))}
                  className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-neutral-300 bg-white text-xs text-neutral-500 dark:border-neutral-600 dark:bg-neutral-800"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex gap-2">
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={person ? '想试哪件？直接说就行' : '先传一张全身照'}
            className="min-w-0 flex-1 rounded-xl border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-950"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
          >
            {busy ? '生成中…' : '发送'}
          </button>
        </div>
      </form>
    </div>
  )
}

function MessageBubble({
  message,
  personUrl,
  onApproval,
  tryOnCostUsd,
}: {
  message: UIMessage
  personUrl: string | null
  onApproval: (approvalId: string, approved: boolean) => void
  tryOnCostUsd: number | null
}) {
  const mine = message.role === 'user'

  return (
    <div className={mine ? 'flex justify-end' : ''}>
      <div className={`space-y-2 ${mine ? 'max-w-[85%]' : 'w-full'}`}>
        {message.parts.map((part, index) => {
          if (part.type === 'text') {
            const raw = part.text
            const body = mine ? stripAnnotationLines(raw) : raw
            const attachments = mine ? parseAttachmentLines(raw) : []

            if (!body && attachments.length === 0) return null

            return (
              <div key={index} className="space-y-2">
                {body && (
                  <div
                    className={
                      mine
                        ? 'rounded-2xl bg-neutral-900 px-3 py-2 text-sm whitespace-pre-wrap text-white dark:bg-neutral-100 dark:text-neutral-900'
                        : 'text-sm whitespace-pre-wrap text-neutral-800 dark:text-neutral-100'
                    }
                  >
                    {body}
                  </div>
                )}
                {attachments.length > 0 && (
                  <p className="text-right text-[11px] text-neutral-400">
                    已附带 {attachments.map((a) => (a.kind === 'person' ? '人物照' : '服装图')).join('、')}
                  </p>
                )}
              </div>
            )
          }

          if (isToolPart(part)) {
            return (
              <ToolCard
                key={index}
                part={part}
                onApproval={onApproval}
                personImageUrl={personUrl}
                tryOnCostUsd={tryOnCostUsd}
              />
            )
          }

          return null
        })}
      </div>
    </div>
  )
}
