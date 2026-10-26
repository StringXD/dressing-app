'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  /** 原图（人物照） */
  beforeSrc: string
  /** 结果图 */
  afterSrc: string
  beforeLabel?: string
  afterLabel?: string
  /**
   * 结果图是不是 AI 生成的 —— 默认是。
   *
   * 这个默认值是对的而不是偷懒：这个组件在本项目里的唯一用途就是
   * "人物原图 vs 生成结果"，`afterLabel` 的默认值也正是「换装后」。
   * 真要拿它对比两张真实照片，那是个新场景，理应显式说明。
   */
  aiGenerated?: boolean
  className?: string
}

/**
 * 原图 / 结果对比滑块。
 *
 * 换装这类效果，单看结果图很难判断"到底换了没有" —— 脸和体型在两张图里
 * 本来就该一模一样。并排摆两张又需要眼睛来回扫。所以做成可拖动的分界线：
 * 同一个像素位置上，左右两侧是同一部位的原图与结果，差异一眼可见。
 *
 * 无障碍：这是可操作控件，所以给了 `role="slider"` 与方向键支持。
 * 只用鼠标拖动的话，键盘用户完全用不了。
 */
export function BeforeAfterSlider({
  beforeSrc,
  afterSrc,
  beforeLabel = '原图',
  afterLabel = '换装后',
  aiGenerated = true,
  className = '',
}: Props) {
  const [position, setPosition] = useState(50)
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  const updateFromClientX = useCallback((clientX: number) => {
    const el = containerRef.current
    if (!el) return

    const { left, width } = el.getBoundingClientRect()
    if (width === 0) return

    const next = ((clientX - left) / width) * 100
    setPosition(Math.min(100, Math.max(0, next)))
  }, [])

  // 指针事件挂在 window 而不是元素上：拖出图片外时不该突然断掉
  useEffect(() => {
    function onMove(event: PointerEvent) {
      if (!draggingRef.current) return
      updateFromClientX(event.clientX)
    }
    function onUp() {
      draggingRef.current = false
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)

    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [updateFromClientX])

  return (
    <div className={className}>
      <div
        ref={containerRef}
        className="relative touch-none overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-100 select-none dark:border-neutral-800 dark:bg-neutral-900"
        onPointerDown={(event) => {
          draggingRef.current = true
          updateFromClientX(event.clientX)
        }}
      >
        {/* 结果图铺满，原图按分界线裁切盖在上面 —— 这样两边尺寸天然对齐 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={afterSrc} alt={afterLabel} className="block w-full" draggable={false} />

        <div
          className="absolute inset-0 overflow-hidden"
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={beforeSrc} alt={beforeLabel} className="block w-full" draggable={false} />
        </div>

        <div
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.15)]"
          style={{ left: `${position}%` }}
        />

        <div
          role="slider"
          tabIndex={0}
          aria-label="拖动对比原图与结果"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(position)}
          aria-valuetext={`显示原图 ${Math.round(position)}%`}
          className="absolute inset-y-0 w-10 -translate-x-1/2 cursor-ew-resize focus:outline-none"
          style={{ left: `${position}%` }}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 10 : 2
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              setPosition((p) => Math.max(0, p - step))
            } else if (event.key === 'ArrowRight') {
              event.preventDefault()
              setPosition((p) => Math.min(100, p + step))
            } else if (event.key === 'Home') {
              event.preventDefault()
              setPosition(0)
            } else if (event.key === 'End') {
              event.preventDefault()
              setPosition(100)
            }
          }}
        >
          <span className="absolute top-1/2 left-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-500 shadow-sm focus-visible:ring-2 focus-visible:ring-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
            <svg viewBox="0 0 20 20" className="size-4" fill="currentColor" aria-hidden="true">
              <path d="M7.5 4.5 3 10l4.5 5.5v-11ZM12.5 4.5v11L17 10l-4.5-5.5Z" />
            </svg>
          </span>
        </div>

        <span className="pointer-events-none absolute top-2 left-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] text-white">
          {beforeLabel}
        </span>
        <span className="pointer-events-none absolute top-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] text-white">
          {afterLabel}
        </span>

        {/*
          显式标识：右侧这一张是 AI 生成的，必须让人一眼看得出来。
          换成同样底色的样式，是为了它和上面的「换装后」读起来是一组信息 ——
          这块像素是什么、以及它从哪来。
        */}
        {aiGenerated && (
          <span className="pointer-events-none absolute top-8 right-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] text-white">
            AI 生成
          </span>
        )}
      </div>

      <p className="mt-2 text-center text-xs text-neutral-400">
        拖动中间的滑块对比（键盘可用 ← → 微调，Shift 加速）
      </p>
    </div>
  )
}
