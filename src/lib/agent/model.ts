import { createAnthropic } from '@ai-sdk/anthropic'

import { env, requireEnv } from '@/lib/env'

type AnthropicProvider = ReturnType<typeof createAnthropic>

/**
 * 默认模型。
 *
 * 默认值是**本阶段实测跑通过的那一个**，不是某个"官方"名字：真正验证过的路径是
 * Anthropic 兼容网关（见 README 的 LLM 接入说明）。如果你的 `ANTHROPIC_BASE_URL`
 * 指向的是官方 api.anthropic.com，**必须显式设 `ANTHROPIC_MODEL` 为 claude 模型** ——
 * 官方端点不认识这个名字，第一次调用就会 400。
 */
const DEFAULT_MODEL = 'deepseek-v4-flash-vision-exp'

/**
 * 未配置网关时使用的地址。与 SDK 内置默认值一致。
 *
 * 之所以**显式传**而不是让 SDK 自己去读 `ANTHROPIC_BASE_URL`：SDK 的
 * `loadOptionalSetting` 只判 null、不把空串当成"没配"，所以 `.env` 里留一行
 * `ANTHROPIC_BASE_URL=` 会让它在调用时抛 `baseURL must be a non-empty string` ——
 * 崩在 SDK 内部，错误也不指向配置。
 *
 * 显式传一个确定的字符串，就等于关掉了 SDK 那条绕过 `env.ts` 校验的后路，
 * 让配置只有一个可信来源。
 */
const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1'

let cachedProvider: AnthropicProvider | undefined

/**
 * 组装供应商。**惰性**，不在模块加载时就要求 Key。
 *
 * 这一点是刻意的，与 `env.ts` 的分层一致：功能必需的 Key 缺失时**不该影响启动**，
 * 否则没配 Key 的人连 `next build` 都过不去，骨架、界面、单测全部无法开发。
 * 只有真正要用 Agent 的那一刻才通过 `requireEnv` 抛出可读错误。
 *
 * `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_EXTRA_HEADERS` 都是可选的：不设就完全走官方行为。
 * 不把某个网关的地址或头写死在这里，是因为这是个自托管项目 —— 用哪家网关是部署者的选择。
 */
function provider(): AnthropicProvider {
  if (!cachedProvider) {
    cachedProvider = createAnthropic({
      apiKey: requireEnv('ANTHROPIC_API_KEY'),
      baseURL: env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL,
      ...(env.ANTHROPIC_EXTRA_HEADERS && { headers: env.ANTHROPIC_EXTRA_HEADERS }),
    })
  }

  return cachedProvider
}

/** 实际使用的模型名。暴露出来是为了在日志与错误信息里能说清"刚才调用的是谁"。 */
export const AGENT_MODEL_ID = env.ANTHROPIC_MODEL ?? DEFAULT_MODEL

/**
 * 取 Agent 用的语言模型。
 *
 * 每次调用都返回同一个底层实例（provider 有缓存），所以放进请求处理里也没有额外开销。
 */
export function getAgentModel() {
  return provider().messages(AGENT_MODEL_ID)
}
