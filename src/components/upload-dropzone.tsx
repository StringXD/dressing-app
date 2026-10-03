'use client'

import { useCallback, useRef, useState } from 'react'

export interface UploadedAsset {
  id: string
  url: string
  mime: string
  width: number
  height: number
  bytes: number
}

interface UploadFailure {
  filename: string
  reason: string
}

interface UploadResponse {
  assets: UploadedAsset[]
  failed: UploadFailure[]
}

type Phase = 'idle' | 'uploading' | 'done'

interface Props {
  /** 上传成功后回调，用于把 asset 交给上层（后续接 Agent / 生成流程） */
  onUploaded?: (assets: UploadedAsset[]) => void
  /** 是否允许多选。人物照只取一张，服装图常常一次传好几件 */
  multiple?: boolean
  label?: string
  hint?: string
}

export function UploadDropzone({
  onUploaded,
  multiple = false,
  label = '上传照片',
  hint,
}: Props) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [dragging, setDragging] = useState(false)
  const [assets, setAssets] = useState<UploadedAsset[]>([])
  const [failures, setFailures] = useState<UploadFailure[]>([])
  const [error, setError] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  const upload = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files)
      if (list.length === 0) return

      setPhase('uploading')
      setError(null)
      setFailures([])

      const form = new FormData()
      for (const file of list) {
        form.append('file', file)
      }

      try {
        const res = await fetch('/api/upload', { method: 'POST', body: form })
        const body = (await res.json()) as UploadResponse & { error?: string }

        if (!res.ok && body.assets.length === 0) {
          setError(body.error ?? `上传失败（HTTP ${res.status}）`)
          setPhase('idle')
          return
        }

        // 部分失败时仍然保留成功的那些，不整单丢弃
        setAssets(body.assets)
        setFailures(body.failed ?? [])
        setPhase('done')
        onUploaded?.(body.assets)
      } catch (err) {
        setError(err instanceof Error ? err.message : '网络错误')
        setPhase('idle')
      }
    },
    [onUploaded],
  )

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setDragging(false)
      void upload(event.dataTransfer.files)
    },
    [upload],
  )

  return (
    <div className="w-full">
      {/* 拖拽 / 点击区域 */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={[
          'flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition',
          dragging
            ? 'border-neutral-900 bg-neutral-100 dark:border-neutral-100 dark:bg-neutral-800'
            : 'border-neutral-300 hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-500',
        ].join(' ')}
      >
        <div className="text-3xl">📷</div>
        <p className="mt-3 text-base font-medium">{label}</p>
        <p className="mt-1 text-sm text-neutral-500">
          点击选择，或把图片拖到这里
        </p>
        {hint && <p className="mt-2 text-xs text-neutral-400">{hint}</p>}
        {phase === 'uploading' && (
          <p className="mt-3 text-sm text-neutral-500">正在处理…</p>
        )}
      </div>

      {/* 移动端直接调起相机 */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          cameraInputRef.current?.click()
        }}
        className="mt-3 w-full rounded-xl border border-neutral-300 py-2.5 text-sm transition hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800 sm:hidden"
      >
        直接用相机拍
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void upload(e.target.files)
          e.target.value = '' // 允许重复选同一个文件
        }}
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void upload(e.target.files)
          e.target.value = ''
        }}
      />

      {/* 错误 */}
      {error && (
        <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {/* 部分失败明细：批量上传时"3 张成功 1 张不行"很常见，要逐条说明 */}
      {failures.length > 0 && (
        <ul className="mt-3 space-y-1">
          {failures.map((f) => (
            <li
              key={f.filename}
              className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300"
            >
              <span className="font-medium">{f.filename}</span>：{f.reason}
            </li>
          ))}
        </ul>
      )}

      {/* 结果预览 */}
      {phase === 'done' && assets.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-sm text-neutral-500">
            已上传 {assets.length} 张
          </p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {assets.map((a) => (
              <div
                key={a.id}
                className="aspect-3/4 overflow-hidden rounded-xl bg-neutral-100 dark:bg-neutral-800"
              >
                {/* 这里用原生 img 而不是 next/image：
                    图片来自本地上传、尺寸已归一，且需要按 cookie 鉴权，
                    走 next/image 的优化管线反而要额外配置 remotePatterns。 */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={a.url}
                  alt="已上传"
                  className="h-full w-full object-cover"
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
