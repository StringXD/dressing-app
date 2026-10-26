import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 这一组测的不是"配置读进来了没有"，而是**配置有没有真的变成线上的请求**。
 *
 * 为什么值得单独测：`ANTHROPIC_BASE_URL` / `ANTHROPIC_EXTRA_HEADERS` 属于典型的
 * "配错了也照样绿"的设置 —— 类型对、编译过、单测全绿，直到真的调用时才收到
 * 一个不知道从哪儿来的 400。实测已知：某个网关不带头 `x-opencode-session` 就
 * 直接 400 `MissingSessionID`。
 *
 * 做法是桩掉**全局 fetch**、但保留真实的 provider 与 `generateText`：
 * 这样 URL、请求头、请求体全都是真代码生成出来的，只有网络那一段被换掉。
 * 于是它免费、离线、可进 CI，却仍然能证明"话确实说对了"。
 */

/** 一份最小可用的 Anthropic messages 响应，够 generateText 收尾即可 */
function anthropicResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_probe',
      type: 'message',
      role: 'assistant',
      model: 'probe',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

type FetchMock = ReturnType<
  typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
>

/**
 * 按给定环境重新加载 model 模块。
 *
 * `env.ts` 在导入时就解析 `process.env`，所以必须"先设环境、再导入"，
 * 且要先 `resetModules()` 拿掉上一次的缓存。
 */
async function loadAgent(extra: Record<string, string> = {}) {
  vi.resetModules()
  vi.stubEnv('DATABASE_URL', 'postgres://probe:probe@localhost:5432/probe')
  vi.stubEnv('ANTHROPIC_API_KEY', 'oc_sk_probe')
  // 设成**空串**而不是删掉：这是 `.env` 里"取消了注释但没填值"的真实形态，
  // 也是下面那条用例要守的场景。避免宿主机的 .env 让断言飘忽。
  vi.stubEnv('ANTHROPIC_BASE_URL', '')
  vi.stubEnv('ANTHROPIC_MODEL', '')
  vi.stubEnv('ANTHROPIC_EXTRA_HEADERS', '')
  for (const [key, value] of Object.entries(extra)) vi.stubEnv(key, value)

  const [{ generateText }, modelModule] = await Promise.all([
    import('ai'),
    import('./model'),
  ])

  return { generateText, ...modelModule }
}

/** 跑一次真实调用，返回被拦截下来的那一次请求 */
async function captureRequest(extra: Record<string, string> = {}) {
  const fetchMock: FetchMock = vi.fn(async () => anthropicResponse())
  vi.stubGlobal('fetch', fetchMock)

  const { generateText, getAgentModel } = await loadAgent(extra)
  await generateText({ model: getAgentModel(), prompt: 'hi' })

  const [url, init] = fetchMock.mock.calls[0]
  const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined

  return { url: String(url), headers: new Headers(init?.headers), body }
}

describe('agent 供应商装配', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('baseURL 与自定义请求头真的发到了网络上', async () => {
    const { url, headers, body } = await captureRequest({
      ANTHROPIC_BASE_URL: 'https://gateway.test/zen/go/v1',
      ANTHROPIC_EXTRA_HEADERS: '{"x-opencode-session":"dressing-app"}',
    })

    // baseURL 是**前缀**，SDK 自己在后面拼 /messages
    expect(url).toBe('https://gateway.test/zen/go/v1/messages')
    expect(headers.get('x-opencode-session')).toBe('dressing-app')
    expect(headers.get('x-api-key')).toBe('oc_sk_probe')
    expect((body as { model?: string }).model).toBe('deepseek-v4-flash-vision-exp')
  })

  it('ANTHROPIC_BASE_URL 留空时按未配置处理，不能崩在 SDK 内部', async () => {
    // 这条守的是一个真实踩到的坑：SDK 的 loadOptionalSetting 只判 null，
    // **不把空串当"没配"**，于是 `.env` 里留一行 `ANTHROPIC_BASE_URL=` 会让它
    // 抛 `baseURL must be a non-empty string` —— 崩在 SDK 内部，错误不指向配置。
    // 修法是显式传 baseURL，关掉 SDK 那条绕过 env.ts 校验的回退路径。
    const { url, headers } = await captureRequest()

    expect(url).toBe('https://api.anthropic.com/v1/messages')
    // 没配就不该凭空多出那个网关头，否则官方端点会收到一个陌生头
    expect(headers.get('x-opencode-session')).toBeNull()
  })

  it('ANTHROPIC_MODEL 覆盖默认模型，且覆盖真的生效', async () => {
    // 这条是防"默认值写死、配置没人读"——只断言 AGENT_MODEL_ID 是空测
    const { body } = await captureRequest({ ANTHROPIC_MODEL: 'claude-sonnet-4-5' })

    expect((body as { model?: string }).model).toBe('claude-sonnet-4-5')
  })

  it('缺少 API Key 时在真正用 Agent 的那一刻才报错，且错误可操作', async () => {
    vi.resetModules()
    vi.stubEnv('DATABASE_URL', 'postgres://probe:probe@localhost:5432/probe')
    vi.stubEnv('ANTHROPIC_API_KEY', '')

    const { getAgentModel } = await import('./model')

    // 导入本身不能抛：否则没配 Key 的人连 next build 都过不去
    expect(() => getAgentModel()).toThrow(/ANTHROPIC_API_KEY/)
  })
})
