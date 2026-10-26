import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * 守的是**审批回执到底能不能发出去**。
 *
 * 背景（真实事故）：`useChat()` 不传 `sendAutomaticallyWhen` 时，点"确认生成"
 * 只会把本地状态改成 `approval-responded`，界面显示"你已确认，正在执行…"，
 * 但回执**永远不发给服务端**，工具体不执行。用户以为批准了，实际什么都没发生 ——
 * 不报错、不警告、不花钱，也没有任何痕迹，只有数据库里少了一行 `generations`。
 *
 * ai@7 的实现里那行守卫写得很明确：
 *   `if (status !== 'streaming' && status !== 'submitted' && this.sendAutomaticallyWhen)`
 * 没传回调就直接短路，`makeRequestForToolApproval` 根本不会被调用。
 *
 * ── 为什么是读源码而不是渲染组件 ──────────────────────────────
 * 这套单测跑在 `environment: 'node'` 下（见 vitest.config.mts），没有 DOM，
 * 而 `ChatPanel` 是 `'use client'` 且依赖 `useChat` 这个 hook，渲染不了。
 * 引入 jsdom + @testing-library/react 只为这一条断言，代价不划算。
 * 所以这里退一步：**断言那份装配确实存在**。
 *
 * ── 什么情况下它该红 ────────────────────────────────────────
 * 把 `sendAutomaticallyWhen: ...` 那行删掉、改成别的值、或把导入删掉，
 * 这条测试就变红。这正是本次事故的形态。
 *
 * ── 它不保证什么 ────────────────────────────────────────────
 * 它**不**证明运行时真有请求发出去，只证明装配在。真正的端到端验证
 * 仍然只能靠在浏览器里点一次"确认生成"、然后看 `generations` 有没有多一行。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const SOURCE = readFileSync(
  resolve(import.meta.dirname, 'chat-panel.tsx'),
  'utf8',
)

describe('审批回执必须真的发得出去', () => {
  // 没有这一步，上面那段说明"为什么"的注释里出现的 `sendAutomaticallyWhen`
  // 会满足断言 —— 代码删了测试还是绿的，就成了一个假测试。
  const code = stripComments(SOURCE)

  it('剥掉注释后，源码里不再残留说明文字（防止上一条断言被注释喂饱）', () => {
    expect(code).not.toContain('不报错、不警告、不花钱')
  })

  it('useChat 装配了 sendAutomaticallyWhen，且用的是审批专用那个回调', () => {
    expect(code).toContain(
      'sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses',
    )
  })

  it('那个回调确实从 ai 导入，不是没定义的名字', () => {
    expect(code).toMatch(
      /import\s*\{[^}]*lastAssistantMessageIsCompleteWithApprovalResponses[^}]*\}\s*from\s*'ai'/,
    )
  })

  it('审批入口本身还在（否则上面两条守的是一个没人调用的选项）', () => {
    expect(code).toContain('addToolApprovalResponse')
  })
})
