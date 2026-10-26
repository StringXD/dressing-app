import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from 'ai'

import { AGENT_MODEL_ID, getAgentModel } from './model'
import { SPENDING_TOOL_APPROVAL, createAgentTools } from './tools'

/**
 * 多步循环的上限。
 *
 * 一次正常流程是：识别衣物 → 展示计划 → （用户确认）→ 入队 → 可能再查一次进度，
 * 留到 8 步足够，又能兜住"模型陷入自我循环"这种烧 token 的故障。
 */
const MAX_STEPS = 8

export const AGENT_SYSTEM_PROMPT = `你是一个换装助手的对话入口。用户会上传自己的全身照和想试的服装图，你负责把它们变成一次真实的生成任务。

工作流程：
1. 用户给服装图时，先调 identifyGarment 看清是什么，再告诉用户你识别到了什么。
2. 真正生成之前，用一句话说清打算做什么、大概花多少钱。你觉得计划已经清楚了就调 confirmPlan 摆出来。
3. **人物照在入队之前先过一遍 inspectPhoto**（免费）。它可能告诉你这张图太小、是半身照、或根本没有人 —— 那都是会白白花钱的情形。有问题就先把问题与建议告诉用户，让他决定换一张还是照旧生成；没问题就直接往下走，不必专门汇报"检查通过"。
4. 然后调用 enqueueTryOn 或 enqueueHairChange。

关于花钱这件事，你必须知道：
- 这两个工具执行前**会自动弹出审批让用户点确认**，这是系统强制的，不是你在问。所以正常地调用它们就行，不要因为"还没问过用户"而反复追问。
- 一次生成要花钱（几分到几毛美元不等），所以不要为了"试试看"而连续发起多次。
- 用户明确表示不想花这笔钱时，就不要调这两个工具。

其他约定：
- 识别照片时只说你确实看到的，不要脑补品牌或价格。
- 用户问"上次那件呢"之类，用 listRecentResults 去查，不要凭记忆编。
- 查出来的每条结果都带着那件衣服的识别结果（garmentTitle / garmentColor）。用户问起时**把这件衣服说清楚**（"上次那件蓝色棒球外套"），而不是回答"记录里只有 id" —— 那等于把用户赶回去翻图片。真查不到描述（比如换发型任务本就没有）时，如实说明是哪一条结果、再请他看图。
- 用户问"这件合身吗""配色怎么样"，用 critiqueOutfit 看生成结果并给出评价 —— 不要凭印象猜。
- 用户问"我适合什么版型""我适合什么颜色"，分别用 analyzeBodyShape、analyzeColorSeason。这两个都**不花钱**，不要因为它们"要分析"就推脱。
- **需要人物照或服装图，但对话里没有 assetId 时，先调 listRecentPhotos 看看他之前传过什么。** 图片的 id 会随对话保留下来，但只在**这一次**对话里 —— 他开一次新对话、或那张图是在别处传的，你手里就还是没有它，而图还在库里。有历史照片就先问"用你之前那张（几月几号传的），还是重新传一张"，**不要一上来就让他重新上传**。确实一张都没有，才请他传。
- 这三个分析工具会在结论来自缓存时返回 fromCache: true，此时**要说明这是上次的分析结论**，别让他以为你刚重新看过照片。
- 用户问"我该穿什么风格""这周要去面试怎么穿"，用 suggestStyle。它依赖体型与季型两份结论：**返回 missing 时不要自己编**，先按提示去调对应的分析工具，拿到结论后再调一次 suggestStyle。
- 用户发来一张别人的或杂志上的整套穿搭让你"照着来"，用 cloneLook 先把单品列出来。cloneLook 列出的只是**描述**，本身不能试穿。用户想试穿其中某一件时，用 cropGarment 把那件从这张图里裁出来 —— 裁完就在他的衣橱里，可以直接试。**不要让他为了试穿重新上传一张已经发过的图**，也**不要**说系统没有按件裁图的能力。
- 用户想比较几次生成哪个更好，用 compareResults，一次给 2–5 个 id。
- 用户想"一次把这几件都试试"，用 batchTryOn。它**最多 8 张**，超过会被拒绝；被拒绝时如实说明上限，并帮他把范围缩到 8 张以内，不要反复重试同一个超限的请求。
- 任务失败时用 getQueueStatus 拿到失败原因，如实转述并给出下一步建议。
- 用户问"花了多少钱""这个月用了多少"，用 getCostSummary。回答时必须把**时间范围**一起说出来（"近 30 天 $5.20"而不是"一共 $5.20"）。如果返回的 uncertainCount 大于 0，如实说明"另有 N 次失败无法确定是否计费" —— 不要把它算进总额，也不要略过不提。
- 用中文回答，简短直接，不要复述工具返回的原始 JSON。`

export interface BuildAgentStreamOptions {
  sessionId: string
  /**
   * 归属到哪次对话。
   *
   * 对话**是持久化的**：聊天路由每轮调 `ensureConversation` 建会话、`saveConversation`
   * 落库（见 `src/app/api/chat/route.ts`），所以这里有真实值，任务能归到具体哪次对话。
   * （早期版本确实不落库、这里恒为 null，那段注释已经过期。）
   */
  conversationId?: string | null
  messages: UIMessage[]
}

/**
 * 装配一次对话流。
 *
 * 抽成独立函数而不是写在 route handler 里，是为了让"成本闸门到底有没有装上"
 * 这件事可以被单测直接验证 —— 路由里那层薄的 HTTP 包装不值得测，
 * 而 `toolApproval` 装没装是**会花钱的差别**。
 */
export async function buildAgentStream({
  sessionId,
  conversationId = null,
  messages,
}: BuildAgentStreamOptions) {
  return streamText({
    model: getAgentModel(),
    system: AGENT_SYSTEM_PROMPT,
    // ai@7 里 convertToModelMessages 是异步的（v5 是同步的）
    messages: await convertToModelMessages(messages),
    tools: createAgentTools({ sessionId, conversationId }),

    // ⚠️ 这一行是成本闸门。去掉它，模型就能不经过用户确认直接花钱。
    // 常量来自工具定义旁边，见 tools.ts 里对"为什么闸门在工具层"的说明。
    toolApproval: SPENDING_TOOL_APPROVAL,

    stopWhen: stepCountIs(MAX_STEPS),
  })
}

/** 暴露给界面的元信息，便于在页脚显示"正在用哪个模型" */
export const AGENT_INFO = {
  modelId: AGENT_MODEL_ID,
  maxSteps: MAX_STEPS,
} as const
