import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildAgentStream } from '@/lib/agent/chat'
import { createAgentTools } from '@/lib/agent/tools'

/**
 * 这一组守的是**整个项目里唯一会花钱的地方**。
 *
 * 计划把它列为最关键的一条断言：它同时是产品承诺（"用户确认之后才会花钱"）
 * 和技术保障（`toolApproval` 真的装上了）。任何一次重构把这行配置弄丢，
 * 用户都会在毫无提示的情况下被扣钱 —— 而这在单测里原本完全看不见。
 *
 * 关于**哪条断言在真正守卫什么**（都做过变异检验）：
 *  - `tool-approval-request` 出现 → 这条能区分闸门开关。实测把 `toolApproval`
 *    去掉后，流里就只剩 `tool-call`，这条断言变红。
 *  - `enqueueGeneration` 未被调用 → 这是产品层面的结论，但**它单独不具区分力**：
 *    在这个桩环境里模型只跑一步，工具本来就不会执行，去掉闸门它同样不被调用。
 *    真正能变红的是上面那条。留着它是为了把"没花钱"这句话写进断言里，
 *    而不是让读者自己推断。
 *  - 第二条用例直接执行工具，证明"这个工具一旦跑起来确实会入队" ——
 *    否则第一条的"没被调用"有可能只是因为工具压根是坏的。
 *
 * **尚未覆盖**：审批回执走完整往返（客户端批准 → 服务端继续执行）这一段。
 * 桩模型驱动不了它，留待阶段 5 的真实对话跑通时验证。
 */

const { enqueueGeneration, modelHolder } = vi.hoisted(() => ({
  enqueueGeneration: vi.fn(async () => ({ id: 'gen-1', status: 'queued' })),
  modelHolder: { current: undefined as unknown },
}))

vi.mock('@/lib/queue/enqueue', () => ({ enqueueGeneration }))

// 归属校验会查库。这一组只关心"有没有走到工具执行"，所以给一个永远认得出的假库，
// 让单测不必依赖 Postgres（项目的单测一律不连数据库）。
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            { id: 'asset-1', sessionId: 'sess-1', storageKey: 'uploads/a/b.webp' },
          ],
        }),
      }),
    }),
  },
}))

vi.mock('@/lib/agent/model', () => ({
  getAgentModel: () => modelHolder.current,
  AGENT_MODEL_ID: 'mock-model',
}))

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}

const TRYON_INPUT = {
  personAssetId: 'asset-1',
  garmentId: 'garment-1',
  category: 'tops' as const,
  mode: 'balanced' as const,
  garmentPhotoType: 'auto' as const,
}

/** 模型这一步要求调用某个工具 */
function toolCallStream(toolName: string, input: unknown) {
  return convertArrayToReadableStream<LanguageModelV4StreamPart>([
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) },
    {
      type: 'finish',
      // ai@7 里 finishReason 是 { unified, raw } 而不是字符串
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage: USAGE,
    },
  ])
}

const USER_MESSAGE = {
  id: 'm1',
  role: 'user' as const,
  parts: [{ type: 'text' as const, text: '帮我试试这件' }],
}

/** 把流跑到头，返回所有步骤里的内容块 */
async function stepContent(result: Awaited<ReturnType<typeof buildAgentStream>>) {
  await result.consumeStream()

  const content: Array<{ type: string }> = []
  for (const step of await result.steps) content.push(...step.content)

  return content
}

describe('成本闸门：花钱工具必须经用户审批', () => {
  beforeEach(() => {
    enqueueGeneration.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('用户还没点确认时，花钱工具停在审批上，enqueueGeneration 从未被调用', async () => {
    modelHolder.current = new MockLanguageModelV4({
      doStream: [{ stream: toolCallStream('enqueueTryOn', TRYON_INPUT) }],
    })

    const content = await stepContent(
      await buildAgentStream({ sessionId: 'sess-1', messages: [USER_MESSAGE] }),
    )

    // 先证明"确实走到了这一步"：模型确实要求调用那个花钱工具。
    // 少了这句，下面那条断言在"模型压根没被调用"时也会通过 —— 就是个空测。
    expect(content.some((item) => item.type === 'tool-call')).toBe(true)

    // 这条是真正守着闸门的断言：没有它，`toolApproval` 被删掉都不会有人发现
    const approvals = content.filter((item) => item.type === 'tool-approval-request')
    expect(approvals).toHaveLength(1)
    // 而且要拦的是**那个花钱的工具**，不是随便拦了个什么
    expect(JSON.stringify(approvals[0])).toContain('enqueueTryOn')

    expect(enqueueGeneration).not.toHaveBeenCalled()
  })

  it('工具一旦真的执行，确实会入队 —— 证明上一条不是"工具本来就坏的"', async () => {
    const tools = createAgentTools({ sessionId: 'sess-1' })
    const execute = tools.enqueueTryOn.execute
    if (!execute) throw new Error('enqueueTryOn 没有 execute，测试前提不成立')

    const output = await execute(TRYON_INPUT, { toolCallId: 'call-1', messages: [] } as never)

    expect(enqueueGeneration).toHaveBeenCalledTimes(1)
    expect(output).toMatchObject({ generationId: 'gen-1', status: 'queued' })
  })
})
