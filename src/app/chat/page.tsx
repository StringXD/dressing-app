import Link from 'next/link'

import { ChatPanel } from '@/components/chat/chat-panel'
import { ConversationList } from '@/components/chat/conversation-list'
import { AGENT_INFO } from '@/lib/agent/chat'
import { describeTryOnCost } from '@/lib/agent/tools'
import { isConversationId } from '@/lib/chat/conversations'
import { hasEnv } from '@/lib/env'

/**
 * 对话页。
 *
 * 服务端壳：把"配置齐不齐"这类需要读环境变量的事放在这里，
 * 交互全部交给客户端组件。这样 Key 不会以任何形式进入浏览器代码，
 * 缺配置时也能在**发第一条消息之前**就告诉用户，而不是等他打完字再报错。
 */

/**
 * ⚠️ 必须动态渲染，**不要删掉这一行**。
 *
 * 这一页的内容取决于 `hasEnv('ANTHROPIC_API_KEY')`。若按默认的静态预渲染，
 * 分支会在 `next build` 那一刻被烘进产物 —— 于是"构建时没配 Key、
 * 之后才填上"的用户会永远看到那句"对话功能还没配置好"，重启也没用。
 * 对自托管项目来说这是彻底坏掉的：填 Key 的人必然是在构建之后才填。
 *
 * 代价只是这一页不能再静态化，而它本来就是个纯交互壳，没有可缓存的内容。
 */
export const dynamic = 'force-dynamic'

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string | string[] }>
}) {
  const ready = hasEnv('ANTHROPIC_API_KEY')

  /*
   * 对话 id 放在 URL 里（`/chat?c=<uuid>`），而不是只活在前端 state 里。
   *
   * 这是"刷新后消息还在"能成立的前提。id 只存在前端的话，刷新时客户端会
   * 生成一个新的，旧的那次对话就再也回不来了 —— 数据在库里，
   * 但没有任何东西指向它。
   *
   * 没带参数时这里生成一个新的，也就是"新建对话"。客户端挂载后立刻把它
   * 写回地址栏，所以紧接着的那次刷新仍然落在同一次对话上。
   *
   * 这也给上面那条 `force-dynamic` 多加了一个理由：每次请求的 id 都不同，
   * 静态预渲染毫无意义。
   */
  const requested = (await searchParams).c
  const conversationId = isConversationId(requested) ? requested : crypto.randomUUID()

  /*
   * 单张试穿的价格在这里取好、当参数交给客户端。
   *
   * 批量试穿的审批卡片要在**用户点击之前**写出"8 张 · 预计 $0.600"，
   * 而那时工具还没执行，拿不到 execute 的返回值。让客户端自己算的话，
   * 就得把模型注册表打进浏览器包 —— 价格会有两份，迟早对不上，
   * 而"对不上"在花钱这件事上表现为什么，不用猜。
   */
  const tryOnCostUsd = describeTryOnCost()

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 sm:py-14">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">对话</h1>
          <p className="mt-1 text-sm text-neutral-500">
            上传全身照和想试的衣服，说一句想怎么换。
          </p>
        </div>
        <Link href="/" className="shrink-0 text-xs text-neutral-400 hover:text-neutral-600">
          返回首页
        </Link>
      </header>

      {ready ? (
        <>
          {/*
            历史放在对话之上：它是"我在哪"的答案，而用户切换对话时会反复看它。
            放在下方的话，一次长对话要滚到底才能换一次。
          */}
          <ConversationList currentId={conversationId} />
          <ChatPanel tryOnCostUsd={tryOnCostUsd} conversationId={conversationId} />
        </>
      ) : (
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950">
          <h2 className="text-sm font-medium text-amber-900 dark:text-amber-200">
            对话功能还没配置好
          </h2>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            需要在项目根目录的{' '}
            <code className="rounded bg-amber-100 px-1 dark:bg-amber-900">.env</code> 里填上{' '}
            <code className="rounded bg-amber-100 px-1 dark:bg-amber-900">ANTHROPIC_API_KEY</code>
            （官方 Key 或任一 Anthropic 兼容网关都行），重启后即可使用。
            上传功能不受影响，可以先回首页试试。
          </p>
        </section>
      )}

      <footer className="mt-10 border-t border-neutral-100 pt-4 text-xs text-neutral-400 dark:border-neutral-800">
        当前模型 <code>{AGENT_INFO.modelId}</code> · 单次对话最多 {AGENT_INFO.maxSteps} 步
        <br />
        真正的生成会先弹审批，你点了确认才会扣费。
      </footer>
    </main>
  )
}
