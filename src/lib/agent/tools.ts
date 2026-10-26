import { and, eq, inArray } from 'drizzle-orm'
import { generateObject, tool } from 'ai'
import { z } from 'zod'

import { db } from '@/lib/db'
import { assets, garments, generations, type AssessmentKind } from '@/lib/db/schema'
import { BATCH_TRYON_MAX, GARMENT_PHOTO_TYPES } from '@/lib/domain'
import {
  BODY_SHAPE_PROMPT,
  COLOR_SEASON_PROMPT,
  COMPARE_PROMPT,
  CRITIQUE_PROMPT,
  LOOK_PROMPT,
  PHOTO_CHECK_PROMPT,
  STYLE_PROMPT,
  bodyShapeSchema,
  colorSeasonSchema,
  comparisonSchema,
  critiqueSchema,
  findAssessment,
  lookSchema,
  photoCheckSchema,
  recordAssessment,
  styleSuggestionSchema,
} from '@/lib/generation/assessments'
import { cropImage } from '@/lib/image/crop'
import { buildPhotoReport, inspectImageQuality } from '@/lib/image/quality'
import { hairParamsSchema, tryOnParamsSchema } from '@/lib/generation/params'
import { DEFAULT_WINDOW_DAYS, getCostSummary } from '@/lib/generation/costs'
import { listRecentPhotos } from '@/lib/generation/photos'
import { listRecentResults } from '@/lib/generation/results'
import { enqueueGeneration } from '@/lib/queue/enqueue'
import { getQueueItems, getQueueStats } from '@/lib/queue/stats'
import { listModels, resolveModel } from '@/lib/providers'
import {
  GARMENT_CATEGORIES,
  HAIR_COLORS,
  HAIRSTYLES,
  TRYON_MODES,
  UPSTREAM_PHOTO_TYPES,
} from '@/lib/providers/types'
import { buildStorageKey, storage } from '@/lib/storage'

import { AGENT_MODEL_ID, getAgentModel } from './model'

/**
 * Agent 工具集。
 *
 * 三条贯穿全文件的原则：
 *
 * 1. **花钱的工具必须落在 `SPENDING_TOOL_APPROVAL` 里。** 闸门设在工具层而不是
 *    提示词层：靠"模型应该先问用户"这种纪律守钱，迟早会被一次越狱或一次
 *    模型升级冲掉；而 `toolApproval` 是运行时强制的，模型绕不过去。
 *    有单测守着"新增花钱工具忘了登记就变红"。
 *
 * 2. **`enqueueGeneration()` 是唯一入队路径。** 没有 REST 入队路由 ——
 *    多一条路径就多一处要同步配额、归属、参数校验的地方。
 *
 * 3. **每个用户给的 id 都要过归属校验。** 工具参数是模型生成的，而模型看到的
 *    对话里可能有别人贴的 id；不校验就等于把别人的任务状态、别人的图
 *    暴露给任何人。
 */

/**
 * 花钱工具的人工审批表，交给 `streamText` 的 `toolApproval`。
 *
 * 常量放在工具定义旁边，是为了让"新增一个花钱工具"和"登记它"发生在同一个文件里 ——
 * 单测会检查两者是否一致。
 */
export const SPENDING_TOOL_APPROVAL = {
  enqueueTryOn: 'user-approval',
  enqueueHairChange: 'user-approval',
  batchTryOn: 'user-approval',
} as const

/**
 * 单次批量试穿的张数硬上限。
 *
 * 定义在 `@/lib/domain` —— 工作台网格也要用它，而网格是浏览器端代码，
 * 从本文件引会把整个 Agent 与数据库层拉进包里（见那边的注释）。
 */

/**
 * 试穿单张的价格，交给界面在**审批之前**显示。
 *
 * 审批卡片必须写出用户正在批准的那个具体数字（几张、一共多少钱），
 * 而那一刻工具还没执行 —— `execute` 返回的 `estimatedTotalUsd` 帮不上忙。
 * 所以价格要由服务端单独交给界面：让界面自己算，就得把模型注册表
 * 搬进浏览器，那是第二份会漂移的价格真相。
 *
 * 取不到时返回 null 而不是抛错：注册表配置有问题不该让整个对话页打不开，
 * 卡片少一行金额也比白屏好。
 */
export function describeTryOnCost(): number | null {
  try {
    return resolveModel('tryon').costUsdPerRun
  } catch {
    return null
  }
}

/** 已经在审批表里登记的、真正会花钱的工具名 */
export type SpendingToolName = keyof typeof SPENDING_TOOL_APPROVAL

export interface AgentToolContext {
  sessionId: string
  /** 归属到哪次对话，便于后续按对话回溯生成结果 */
  conversationId?: string | null
}

/** 取一个属于本会话的资产；不是自己的就当作不存在 */
async function requireOwnedAsset(sessionId: string, assetId: string) {
  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.sessionId, sessionId)))
    .limit(1)

  // 措辞刻意与"不存在"一致：区分"不是你的"和"没有这个 id"
  // 会让攻击者能用 id 探测别人有哪些资产。
  if (!asset) throw new Error(`找不到图片 ${assetId}，请确认它是你上传的`)

  return asset
}

/** 取一件属于本会话的衣服 */
async function requireOwnedGarment(sessionId: string, garmentId: string) {
  const [garment] = await db
    .select()
    .from(garments)
    .where(and(eq(garments.id, garmentId), eq(garments.sessionId, sessionId)))
    .limit(1)

  if (!garment) throw new Error(`找不到服装 ${garmentId}，请确认它是你上传的`)

  return garment
}

/**
 * 取一张属于本会话的图片的字节，交给视觉模型。
 *
 * 四个工具（识别服装 + 三个分析）要做的是同一件事：**校验归属 → 取字节 → 调视觉模型**。
 * 每处各写一遍的话，总有一处会漏掉归属校验 —— 而那一处就是别人的照片被读到。
 */
async function loadOwnedImage(sessionId: string, assetId: string) {
  const asset = await requireOwnedAsset(sessionId, assetId)

  const file = await storage.get(asset.storageKey)
  if (!file) throw new Error(`图片 ${assetId} 的字节已经不在存储里了，请重新上传`)

  return { asset, file }
}

/** 视觉识别的产出。这三个字段正好对应 `garments` 表的可写列。 */const garmentIdentificationSchema = z.object({
  title: z.string().min(1).describe('这是什么衣服，一句中文，例如「蓝色棒球外套」'),
  color: z.string().min(1).describe('主色，中文，例如「蓝色」'),
  photoType: z
    .enum(GARMENT_PHOTO_TYPES)
    .describe('这张图是平铺拍摄（flat-lay）、穿在人身上（model），还是看不出来（unknown）'),
})

const IDENTIFY_PROMPT = `你在帮一个换装应用登记一件服装。看这张图，回答三件事：
1. 这是什么衣服（尽量具体：款式 + 品类）
2. 主色是什么
3. 这张图是平铺拍摄的，还是穿在真人身上的，还是都看不出来

只描述你确实看到的，不要脑补品牌、材质或价格。看不清就如实说不知道。`

/**
 * 按件裁图的框。四个数都是相对整图的比例（0~1），原点在左上角。
 *
 * 为什么不直接要像素：模型没有原图的坐标系，要像素时它会按自己想象的尺寸算。
 * 比例是它对着一张缩略图也能给对的东西。
 */
const cropBoxSchema = z.object({
  x: z.number().min(0).max(1).describe('框左上角的 x，占整图宽的比例'),
  y: z.number().min(0).max(1).describe('框左上角的 y，占整图高的比例'),
  width: z.number().min(0).max(1).describe('框宽，占整图宽的比例'),
  height: z.number().min(0).max(1).describe('框高，占整图高的比例'),
})

/** 一张照片最多裁几件。上限既挡 JSON 被 token 截断，也挡「把整张图切成碎片」 */
const CROP_MAX_ITEMS = 6

const cropGarmentSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().min(1).describe('这件衣服是什么，一句中文，例如「米色长风衣」'),
        color: z.string().min(1).describe('主色，中文'),
        box: cropBoxSchema,
      }),
    )
    .min(1)
    .max(CROP_MAX_ITEMS)
    .describe('身上每一件可单独试穿的服装，一件一个框'),
})

/**
 * 裁图的提示词。
 *
 * **这份措辞是实测调出来的**（见 scripts/spike-crop-boxes.ts 的结论），改动前先跑
 * 一遍那个脚本看画框图。两个坑都真踩过：
 *  1. 不写「框里只能有衣服本身」时，模型会把头和脸一起框进上装里 —— 那种图交给
 *     试穿上游等于给它一张带人脸的衣服图
 *  2. 不排除配饰时，它会把皮带、皮鞋也当成「服装」，往衣橱里塞不能试穿的东西
 */
const CROP_PROMPT = `这是一张真人照片。请找出这个人身上**每一件可以单独试穿的服装**，每件给一个贴紧它的矩形框。

可以框的只有这五类：上衣、裤子、裙子、连衣裙、外套。
**不要框**鞋子、帽子、围巾、手套、腰带、手表、眼镜、包 —— 那些不能单独试穿。
最多 ${CROP_MAX_ITEMS} 件；超过的场合只框最显眼的那几件。

框用相对整张图片的比例表示，原点在左上角，都是 0~1 的小数：
- x / y：框左上角在整图宽/高里的占比
- width / height：框本身占整图宽/高的比例

举例：一件上衣占了整张图上方中间，左上角在横向 35%、纵向 20% 处，宽占 30%、高占 25%，
就写 x=0.35、y=0.2、width=0.3、height=0.25。

**最重要的一条：框里只能有那件衣服本身。** 具体地说：
- 上装的框从**衣领**开始，不要往上框到脖子、下巴或者脸；照片里的人头不该出现在任何框里
- 下装的框从**裤腰/裙腰**开始，到裤脚/裙摆结束
- 左右两侧贴紧衣服，不要把光着的胳膊或腿框进来
- 不要为了省事把整张照片框进来

只框你确实看见的衣服，看不清或不确定就不要框。每件给一个具体的中文名（款式 + 颜色），
例如「蓝色直筒牛仔裤」。`

/**
 * 三个分析工具的共同流程：**读缓存 → 没缓存才调模型 → 落库**。
 *
 * 抽出来不只是为了少写代码，更是为了"不重复付费"这件事只有一处实现：
 * 如果每个工具各写一遍缓存判断，漏掉一个的后果是**静默地多付一次钱**，
 * 而界面上看不出任何异常。
 */
async function runImageAnalysis<T extends Record<string, unknown>>(params: {
  sessionId: string
  kind: AssessmentKind
  target: { generationId?: string; assetId?: string }
  assetId: string
  prompt: string
  schema: z.ZodType<T>
}): Promise<Record<string, unknown>> {
  const { sessionId, kind, target, assetId, prompt, schema } = params

  const cached = await findAssessment(sessionId, { kind, ...target })
  if (cached) {
    /*
     * 如实带上 fromCache 与当时的分析时间。
     *
     * 把上次的结论说成刚算的，会误导用户 —— 他可能刚换了发型，
     * 而这份结论看的是旧照片。工具描述里要求模型把这件事说出来。
     */
    return { ...cached.payload, fromCache: true, analyzedAt: cached.createdAt }
  }

  const { file } = await loadOwnedImage(sessionId, assetId)

  const { object } = await generateObject({
    model: getAgentModel(),
    schema,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'file', data: file.body, mediaType: file.mime },
        ],
      },
    ],
  })

  await recordAssessment(sessionId, { kind, ...target }, AGENT_MODEL_ID, object)

  return { ...object, fromCache: false, analyzedAt: new Date() }
}

/**
 * 把已存的结论渲染成给模型看的那几段中文。
 *
 * 先过一遍 schema 而不是直接读字段：`payload` 是 jsonb，它的形状只由
 * 写入时的代码保证。schema 演进之后，旧行会以缺字段的形式读回来，
 * 那时 `payload.recommendedCuts.join()` 会抛 TypeError ——
 * 而这是个本该只花几厘钱的咨询工具，不该因为一条历史数据整个失败。
 *
 * 校验不过就退回原始 JSON：模型读得懂 JSON，用户至少还能得到答案，
 * 而不是一个查不出原因的报错。
 */
function renderStoredAssessment(payload: Record<string, unknown>, schema: z.ZodTypeAny) {
  const parsed = schema.safeParse(payload)
  return JSON.stringify(parsed.success ? parsed.data : payload, null, 2)
}

/**
 * 建一套绑定到某会话的工具。
 *
 * 必须是工厂而不是模块级常量：工具要读写"当前是谁"，把它做成全局单例
 * 就等于让并发请求共享身份。
 */
export function createAgentTools(ctx: AgentToolContext) {
  const { sessionId } = ctx

  return {
    /**
     * 识别一件服装并登记到衣橱。
     *
     * **图片刻意不进主对话**：这里单独发起一次视觉调用，只把结论留在对话历史里。
     * 多步循环里反复带上原始图片字节会让 context 迅速膨胀（实测单图 input_tokens
     * 已 1356），而识别只需要发生一次。
     */
    identifyGarment: tool({
      description: '识别一张服装图片里是什么衣服，并把结果登记到用户的衣橱，返回 garmentId',
      inputSchema: z.object({
        assetId: z.string().describe('服装图片的 assetId（来自用户上传）'),
      }),
      execute: async ({ assetId }) => {
        const asset = await requireOwnedAsset(sessionId, assetId)

        const file = await storage.get(asset.storageKey)
        if (!file) throw new Error(`图片 ${assetId} 的字节已经不在存储里了，请重新上传`)

        const { object } = await generateObject({
          model: getAgentModel(),
          schema: garmentIdentificationSchema,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: IDENTIFY_PROMPT },
                // ai@7 起 "image" part 已废弃，一律用 file + mediaType。
                // 同一文件里并存两种写法时，下一个人会照抄旧的那个。
                { type: 'file', data: file.body, mediaType: file.mime },
              ],
            },
          ],
        })

        const [garment] = await db
          .insert(garments)
          .values({
            id: crypto.randomUUID(),
            sessionId,
            assetId: asset.id,
            title: object.title,
            color: object.color,
            photoType: object.photoType,
          })
          .returning()

        return {
          garmentId: garment.id,
          title: garment.title,
          color: garment.color,
          photoType: garment.photoType,
        }
      },
    }),

    /**
     * 把"准备做什么"摆给用户看。
     *
     * 注意：**这个工具本身没有审批**。真正的闸门在下面两个 enqueue 工具上 ——
     * 把确认做成一屏展示、把闸门做在动作上，模型就算跳过了展示，
     * 也依然花不出钱。
     */
    confirmPlan: tool({
      description:
        '在真正生成之前，把计划（做什么、用哪张图、大概花多少钱）展示给用户确认',
      inputSchema: z.object({
        action: z.enum(['tryon', 'hair']).describe('要做哪种生成'),
        summary: z.string().min(1).describe('一句话说清要做什么，中文'),
        estimatedCostUsd: z.number().min(0).describe('预计花费（美元）'),
      }),
      execute: async ({ action, summary, estimatedCostUsd }) => ({
        acknowledged: true,
        action,
        summary,
        estimatedCostUsd,
        note: '计划已展示。真正花钱的那一步会另有一道用户审批，用户不点确认就不会执行。',
      }),
    }),

    /**
     * 结果评价 —— 对生成图给合身度与配色评价。
     *
     * 不花图像成本，所以**不在审批闸门里**：它不提交任何上游生成任务，
     * 只消耗少量 token。为几厘钱让用户点确认，只会稀释闸门的意义 ——
     * 闸门之所以有效，是因为它只在真正扣大钱时出现。
     */
    critiqueOutfit: tool({
      description:
        '对一次已经生成好的换装/换发型结果给出合身度与配色评价，以及具体可执行的改进建议。' +
        '不产生新图、不额外计费。结果若来自缓存（fromCache 为 true），要如实告诉用户这是上次的分析结论',
      inputSchema: z.object({
        generationId: z.string().describe('要评价的生成任务 id'),
      }),
      execute: async ({ generationId }) => {
        const [row] = await db
          .select({ outputAssetId: generations.outputAssetId })
          .from(generations)
          .where(
            and(eq(generations.id, generationId), eq(generations.sessionId, sessionId)),
          )
          .limit(1)

        // 措辞与"不存在"一致，理由同 requireOwnedAsset：
        // 区分"不是你的"和"没有这个 id"会让人能用 id 探测别人的任务
        if (!row) throw new Error(`找不到任务 ${generationId}，请确认它是你发起的`)

        if (!row.outputAssetId) {
          throw new Error('这次任务还没有产出图片，现在无法评价。可以先用 getQueueStatus 看它的进度')
        }

        return runImageAnalysis({
          sessionId,
          kind: 'critique',
          target: { generationId },
          assetId: row.outputAssetId,
          prompt: CRITIQUE_PROMPT,
          schema: critiqueSchema,
        })
      },
    }),

    /** 体型分析 —— 给出适合与不适合的版型。不花钱，见上方 critiqueOutfit 的说明 */
    analyzeBodyShape: tool({
      description:
        '看人物全身照，判断体型并给出适合/建议避开的版型剪裁。不产生新图、不额外计费。' +
        '结论会存下来，同一张照片再问不会重复分析',
      inputSchema: z.object({
        personAssetId: z.string().describe('人物全身照的 assetId'),
      }),
      execute: async ({ personAssetId }) =>
        runImageAnalysis({
          sessionId,
          kind: 'body',
          target: { assetId: personAssetId },
          assetId: personAssetId,
          prompt: BODY_SHAPE_PROMPT,
          schema: bodyShapeSchema,
        }),
    }),

    /** 色彩季型分析 —— 给出适合与建议避开的颜色。不花钱 */
    analyzeColorSeason: tool({
      description:
        '看人物照片，从肤色冷暖、发色与瞳色判断色彩季型，给出适合/建议避开的颜色。' +
        '不产生新图、不额外计费。结论会存下来，同一张照片再问不会重复分析',
      inputSchema: z.object({
        personAssetId: z.string().describe('人物照片的 assetId'),
      }),
      execute: async ({ personAssetId }) =>
        runImageAnalysis({
          sessionId,
          kind: 'season',
          target: { assetId: personAssetId },
          assetId: personAssetId,
          prompt: COLOR_SEASON_PROMPT,
          schema: colorSeasonSchema,
        }),
    }),

    /**
     * 风格建议 —— 把已经存好的两条结论组合起来。不花钱，也不看图。
     *
     * **缺结论时返回 missing，绝不临时补算。** 一个工具做一件事，链路由
     * agent 循环串起来（`stopWhen` 已经有 8 步预算）：这里顺手把体型也算一遍，
     * 就等于把"要不要花钱"的决定藏进了一个用户没感知的调用里，
     * 而且它算出来的结论**不会落库**，用户下次问还得再算一遍。
     */
    suggestStyle: tool({
      description:
        '综合这个人的体型与色彩季型结论，加上要去的场合，给出整体风格方向与具体搭配组合。' +
        '不花钱、不生成新图。若返回 missing（例如 ["body"]），说明对应结论还没有，' +
        '先去调 analyzeBodyShape / analyzeColorSeason，拿到结果后再回来调这个工具',
      inputSchema: z.object({
        personAssetId: z.string().describe('人物照的 assetId'),
        occasion: z.string().min(1).describe('要去什么场合，中文，例如「上班」「约会」「面试」'),
      }),
      execute: async ({ personAssetId, occasion }) => {
        /*
         * 归属校验必须发生在这里，尽管后面两个分析工具各自也会校验。
         *
         * 这条路径上没有任何别的归属校验 —— 读结论的 findAssessment 只带
         * sessionId 与 assetId，而"这个 assetId 是不是这个会话的"它管不着。
         * 少这一行，别人照片上的分析结论就会被拼进这里给出的建议里。
         */
        await requireOwnedAsset(sessionId, personAssetId)

        const [body, season] = await Promise.all([
          findAssessment(sessionId, { kind: 'body', assetId: personAssetId }),
          findAssessment(sessionId, { kind: 'season', assetId: personAssetId }),
        ])

        const missing = [
          body ? null : 'body',
          season ? null : 'season',
        ].filter((v): v is string => v !== null)

        if (!body || !season) {
          return {
            missing,
            hint:
              missing.includes('body') && missing.includes('season')
                ? '这个人的体型与色彩季型都还没分析过，请先依次调用 analyzeBodyShape 与 analyzeColorSeason'
                : missing.includes('body')
                  ? '还没有体型结论，请先调用 analyzeBodyShape'
                  : '还没有色彩季型结论，请先调用 analyzeColorSeason',
          }
        }

        const { object } = await generateObject({
          model: getAgentModel(),
          schema: styleSuggestionSchema,
          prompt: `${STYLE_PROMPT}

体型结论：
${renderStoredAssessment(body.payload, bodyShapeSchema)}

色彩季型结论：
${renderStoredAssessment(season.payload, colorSeasonSchema)}

场合：${occasion}`,
        })

        /*
         * 刻意**不落库**，与上面三个分析工具不同。
         *
         * 它是从两条已存结论推导出来的，本身不含新的观察：留着只是把
         * "结论的结论"又缓存一层。而这一层比上一层更容易过期 ——
         * 用户重新分析体型（换了新照片）之后，这条建议会继续按旧体型作答，
         * 且没有任何东西提示它已经作废。推导很便宜，重算即可。
         */
        return {
          ...object,
          basedOn: {
            body: { analyzedAt: body.createdAt, modelId: body.modelId },
            season: { analyzedAt: season.createdAt, modelId: season.modelId },
          },
          note: '这是基于上面两份结论推导的。若两份结论的时间不同，说明它们的照片可能不是同一批，可以如实告诉用户。',
        }
      },
    }),

    /**
     * 整套复现 —— 从一张图里提取全部单品。不花钱。
     *
     * **不登记进衣橱**，这是本工具最重要的约束，见描述里的说明。
     */
    cloneLook: tool({
      description:
        '从一张整套穿搭的照片里提取出全部单品（上衣、外套、下装、鞋、包、配饰）以及整体风格。不花钱、不生成新图。' +
        '注意：提取出的单品**不会**进入衣橱，也**不能直接用来试穿** —— ' +
        '一张图里有多件衣服，硬拿整张图去试穿会得到错误的结果 —— 要试穿得先按件裁开。' +
        '用户想试穿其中某一件时，直接用 cropGarment 把它裁出来登记进衣橱（裁图在本机做、不花钱）',
      inputSchema: z.object({
        assetId: z.string().describe('整套穿搭照片的 assetId'),
      }),
      execute: async ({ assetId }) =>
        runImageAnalysis({
          sessionId,
          kind: 'look',
          target: { assetId },
          assetId,
          prompt: LOOK_PROMPT,
          schema: lookSchema,
        }),
    }),


    /**
     * 结果对比 —— 2–5 张产物图放一起比。不花钱。
     *
     * 上限 5 是上下文与成本的双重考虑：每张图约 1356 input tokens，
     * 5 张已经接近识别单图的 7 倍。
     */
    compareResults: tool({
      description:
        '把 2–5 次生成的结果放在一起对比，逐张说明好在哪、差在哪，并推荐留哪一张。不花钱、不生成新图',
      inputSchema: z.object({
        generationIds: z
          .array(z.string())
          .min(2)
          .max(5)
          .describe('要对比的生成任务 id，2–5 个，必须都属于本会话'),
      }),
      execute: async ({ generationIds }) => {
        /*
         * 先按 id 去重。
         *
         * 模型很容易把同一个 id 传两遍（尤其在这种"列举几个"的参数上），
         * 而重复的图片会**照原样各占一份 input token**，还让差异分析里
         * 出现两条互相矛盾的记录 —— 同一个 id 既"更好"又"更差"。
         */
        const ids = [...new Set(generationIds)]
        if (ids.length < 2) throw new Error('至少要两次不同的生成才能对比')

        const rows = await db
          .select({ id: generations.id, outputAssetId: generations.outputAssetId })
          .from(generations)
          .where(
            and(eq(generations.sessionId, sessionId), inArray(generations.id, ids)),
          )

        /*
         * 数量对不上就整体失败，而不是拿剩下的几张勉强比一遍。
         *
         * 这个判断同时兜住两件事：id 不存在、以及 id 不属于本会话。
         * 两者都只给一句"请重新确认要对比哪几张" —— 与 requireOwnedAsset
         * 同一个理由：措辞区分开就等于让人能用 id 探测别人的任务有没有结果。
         */
        if (rows.length !== ids.length) {
          throw new Error('要对比的生成任务里有不属于你的或已不存在的，请重新确认要对比哪几张')
        }

        // 用类型谓词收窄，而不是 `!`：后面的每一次取字节都依赖这个非空判断
        const ready = rows.filter(
          (row): row is { id: string; outputAssetId: string } => !!row.outputAssetId,
        )

        if (ready.length < 2) {
          throw new Error(
            `要对比的 ${ids.length} 次生成里只有 ${ready.length} 次已经产出图片，至少要两次才能对比`,
          )
        }

        // 保持用户给出的顺序：产物图与 id 的对应关系全靠这个顺序，
        // 一旦错位，模型会把 A 的差异安到 B 头上，而界面上看不出错
        const byId = new Map(ready.map((row) => [row.id, row]))
        const ordered = ids
          .map((id) => byId.get(id))
          .filter((row): row is { id: string; outputAssetId: string } => !!row)

        const groups = await Promise.all(
          ordered.map(async (row) => {
            const asset = await requireOwnedAsset(sessionId, row.outputAssetId)

            const file = await storage.get(asset.storageKey)
            if (!file) {
              throw new Error(`图片 ${row.outputAssetId} 的字节已经不在存储里了，无法参与对比`)
            }

            return [
              { type: 'text' as const, text: `下面这张图的 generationId 是 ${row.id}` },
              { type: 'file' as const, data: file.body, mediaType: file.mime },
            ]
          }),
        )

        const { object } = await generateObject({
          model: getAgentModel(),
          schema: comparisonSchema,
          messages: [
            {
              role: 'user',
              // 提示词在前，随后依次是每张图的 id 标签与图片本身
              content: [
                { type: 'text' as const, text: COMPARE_PROMPT },
                ...groups.flat(),
              ],
            },
          ],
        })

        /*
         * 逐条落库，每条只放属于它自己的那部分差异。
         *
         * kind 用 'comparison' 而不是 'critique'：两者 payload 形状不同，
         * 而唯一索引是按 (kind, generation_id) 建的。共用 kind 的后果是
         * 一次对比会占住某个 generation 的 critique 槽位，之后 critiqueOutfit
         * 读缓存时把对比结论当成合身度评价返回 —— 详见 schema.ts 上那段说明。
         */
        await Promise.all(
          ordered.map((row) => {
            const difference = object.differences.find((d) => d.generationId === row.id)

            return recordAssessment(
              sessionId,
              { kind: 'comparison', generationId: row.id },
              AGENT_MODEL_ID,
              {
                verdict: object.verdict,
                recommendation: object.recommendation,
                // 没匹配上就存 null，而不是编一个：宁可让界面少一行，
                // 也不要把别的图的差异安到这一张头上
                difference: difference
                  ? { betterAt: difference.betterAt, worseAt: difference.worseAt }
                  : null,
              },
            )
          }),
        )

        /*
         * 刻意不读缓存。
         *
         * 对比本身只花 token（几厘钱），而"比哪几张"每次都不同 ——
         * 缓存键要覆盖整个 id 集合才有意义，否则用户换一张再比，
         * 读回来的会是上一组的结论。为省这点钱引入一个容易读错的缓存，
         * 不划算。
         */
        return { ...object, compared: ordered.length }
      },
    }),

    /**
     * 输入质量预检 —— **在花钱之前把不合格的照片拦下来**。
     *
     * 存在的理由是两条实测事实（见 `.narrafork/plans/plan-shimmering-sprouting-quasar.md`）：
     *
     * 1. FASHN 的输出分辨率**等于输入分辨率** —— 270×360 进、270×360 出。
     *    小图照样收 $0.075，只是拿回来一张糊的。
     * 2. FASHN 会对人物图跑姿态检测，半身照/非真人照片直接 422。
     *
     * 免费（只消耗 token），所以不在审批闸门里。
     */
    inspectPhoto: tool({
      description:
        '检查一张准备用来做换装的照片能不能用：分辨率够不够、图里有没有人、取景是不是全身、清不清晰。' +
        '不花钱、不生成新图。**发起换装之前先调它**（角色是人物照时），有问题就先告诉用户并给出建议，' +
        '让他决定换一张还是照旧生成。' +
        'role 传 garment 时只做分辨率检查 —— 服装图本来就不该有"图里有没有人"这回事',
      inputSchema: z.object({
        assetId: z.string().describe('要检查的图片 assetId'),
        role: z
          .enum(['person', 'garment'])
          .default('person')
          .describe('这张图准备当什么用；person 会额外检查取景与清晰度'),
      }),
      execute: async ({ assetId, role }) => {
        /*
         * 归属校验先做，尽管几何检查只用到宽高。
         *
         * 宽高本身就是关于一张照片的信息（"这张是 512×512"能说明不少事），
         * 而它来自别人的会话 —— 与 requireOwnedAsset 同一条原则。
         */
        const asset = await requireOwnedAsset(sessionId, assetId)
        const dims = { width: asset.width, height: asset.height }

        if (role === 'garment') {
          /*
           * 服装图只做几何检查。
           *
           * 硬套人物检查会得到一条"图里没有人"的假警报 —— 那比不检查更糟：
           * 它会教模型忽略这个工具的结论，而下次真正的警报也就没人当回事了。
           */
          return { ...inspectImageQuality(dims), check: null, advice: [], fromCache: false, analyzedAt: null }
        }

        const cached = await findAssessment(sessionId, { kind: 'photo', assetId })
        const cachedCheck = cached ? photoCheckSchema.safeParse(cached.payload) : null

        if (cached && cachedCheck?.success) {
          return {
            ...buildPhotoReport(dims, cachedCheck.data),
            check: cachedCheck.data,
            fromCache: true,
            analyzedAt: cached.createdAt,
          }
        }

        const { file } = await loadOwnedImage(sessionId, assetId)

        const { object } = await generateObject({
          model: getAgentModel(),
          schema: photoCheckSchema,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: PHOTO_CHECK_PROMPT },
                { type: 'file', data: file.body, mediaType: file.mime },
              ],
            },
          ],
        })

        await recordAssessment(sessionId, { kind: 'photo', assetId }, AGENT_MODEL_ID, object)

        return {
          ...buildPhotoReport(dims, object),
          check: object,
          fromCache: false,
          analyzedAt: new Date(),
        }
      },
    }),

    /**
     * 换装入队 —— **花钱**。
     *
     * 上游取值由 `tryOnParamsSchema` 校验，不在这里另抄一份枚举：抄一份迟早漂移。
     */
    enqueueTryOn: tool({
      description: `发起一次换装生成（会花钱）。需要先说清用哪张人物照、哪件衣服，以及按什么品类去换。品类可选：${GARMENT_CATEGORIES.join(' / ')}`,
      inputSchema: z.object({
        personAssetId: z.string().describe('人物照的 assetId'),
        garmentId: z.string().describe('由 identifyGarment 返回的 garmentId'),
        category: z.enum(GARMENT_CATEGORIES).default('auto'),
        mode: z.enum(TRYON_MODES).default('balanced'),
        garmentPhotoType: z.enum(UPSTREAM_PHOTO_TYPES).default('auto'),
      }),
      execute: async ({ personAssetId, garmentId, category, mode, garmentPhotoType }) => {
        // 先校验参数再动任何东西：参数不合法时不该留下半条记录
        const params = tryOnParamsSchema.parse({ category, mode, garmentPhotoType })

        await requireOwnedAsset(sessionId, personAssetId)
        await requireOwnedGarment(sessionId, garmentId)

        const model = resolveModel('tryon')

        const generation = await enqueueGeneration({
          sessionId,
          conversationId: ctx.conversationId,
          taskKind: 'tryon',
          model,
          personAssetId,
          garmentId,
          params,
        })

        return {
          generationId: generation.id,
          status: generation.status,
          model: model.label,
          costUsd: model.costUsdPerRun,
        }
      },
    }),

    /** 换发型入队 —— **花钱** */
    enqueueHairChange: tool({
      description: `发起一次换发型生成（会花钱）。需要人物照与想要发型、发色。发型可选：${HAIRSTYLES.join(' / ')}；发色可选：${HAIR_COLORS.join(' / ')}`,
      inputSchema: z.object({
        personAssetId: z.string().describe('人物照的 assetId'),
        hairstyle: z.enum(HAIRSTYLES),
        color: z.enum(HAIR_COLORS),
      }),
      execute: async ({ personAssetId, hairstyle, color }) => {
        const params = hairParamsSchema.parse({ hairstyle, color })

        await requireOwnedAsset(sessionId, personAssetId)

        const model = resolveModel('hair')

        const generation = await enqueueGeneration({
          sessionId,
          conversationId: ctx.conversationId,
          taskKind: 'hair',
          model,
          personAssetId,
          params,
        })

        return {
          generationId: generation.id,
          status: generation.status,
          model: model.label,
          costUsd: model.costUsdPerRun,
        }
      },
    }),

    /**
     * 批量试穿 —— **花钱，而且是本应用里唯一一次能花掉大钱的动作**。
     *
     * 单张的代价是 $0.075；一次 8 张就是 $0.6。所以它同时受三道约束：
     * 硬上限、`SPENDING_TOOL_APPROVAL`（闸门）、以及审批卡片上写明的张数与总额。
     */
    batchTryOn: tool({
      description: `批量试穿：把多张人物照与多件衣服**交叉组合**，一次发起全部配对（会花钱，一次提交多张）。` +
        `单次最多 ${BATCH_TRYON_MAX} 张 —— 这是硬上限，人物数 × 衣服数超过它就会被拒绝。` +
        `执行前会弹出审批，卡片上会写明张数与预估总额。` +
        `品类可选：${GARMENT_CATEGORIES.join(' / ')}`,
      inputSchema: z.object({
        personAssetIds: z.array(z.string()).min(1).describe('人物照的 assetId 列表'),
        garmentIds: z
          .array(z.string())
          .min(1)
          .describe('要试的衣服 garmentId 列表（来自 identifyGarment）'),
        category: z.enum(GARMENT_CATEGORIES).default('auto'),
        mode: z.enum(TRYON_MODES).default('balanced'),
        garmentPhotoType: z.enum(UPSTREAM_PHOTO_TYPES).default('auto'),
      }),
      execute: async ({ personAssetIds, garmentIds, category, mode, garmentPhotoType }) => {
        /*
         * 去重之后再做笛卡尔积。
         *
         * 上限检查必须落在**去重后的真实组合数**上：模型传
         * ['a','a','a'] 时，按入参长度算会以为要生成 3 组，
         * 实际只有 1 组；反过来，两边各传 4 个重复项也可能让真实张数
         * 远超用户看到的数字。用户批准的应该是真实会发生的张数。
         */
        const persons = [...new Set(personAssetIds)]
        const garments = [...new Set(garmentIds)]

        const pairs = persons.flatMap((personAssetId) =>
          garments.map((garmentId) => ({ personAssetId, garmentId })),
        )

        /*
         * 上限检查必须在**第一个 enqueueGeneration 之前**完成。
         *
         * 先入队再检查是错的：那样超限时会留下一半已经提交上去的任务，
         * 用户看到"失败"却已经被扣了钱，还得自己去收拾那几条记录。
         * "一张都不入队"是能保证的，只要这个判断发生在循环之前。
         *
         * 变异检验记录：把这整块挪到循环之后，错误信息一字不差，
         * 而上面那条断言会以 `expected vi.fn() to not be called at all,
         * but actually been called 12 times` 变红。
         */
        if (pairs.length > BATCH_TRYON_MAX) {
          throw new Error(
            `这次会生成 ${persons.length} × ${garments.length} = ${pairs.length} 张，` +
              `超过单次上限 ${BATCH_TRYON_MAX} 张。请减少人物或衣服的数量后重试`,
          )
        }

        // 参数不合法时不该留下半条记录，所以解析放在最前面
        const params = tryOnParamsSchema.parse({ category, mode, garmentPhotoType })

        // 归属校验一次性全部做完，理由同上：任何一件不属于本会话的东西，
        // 都不该让前面那几对先提交上去
        for (const personAssetId of persons) {
          await requireOwnedAsset(sessionId, personAssetId)
        }
        for (const garmentId of garments) {
          await requireOwnedGarment(sessionId, garmentId)
        }

        const model = resolveModel('tryon')

        const created: string[] = []
        for (const pair of pairs) {
          // 逐个走 enqueueGeneration —— 唯一入队路径，见文件头第 2 条。
          // 另写一条批量入队会多出一处要同步配额、归属、参数校验的地方。
          const generation = await enqueueGeneration({
            sessionId,
            conversationId: ctx.conversationId,
            taskKind: 'tryon',
            model,
            personAssetId: pair.personAssetId,
            garmentId: pair.garmentId,
            params,
          })

          created.push(generation.id)
        }

        return {
          generationIds: created,
          count: created.length,
          model: model.label,
          costUsdPerRun: model.costUsdPerRun,
          // 卡片与模型都用它来告诉用户"这一下花了多少"，
          // 而不是让他事后去账单里找
          estimatedTotalUsd: model.costUsdPerRun * created.length,
        }
      },
    }),

    /** 查队列与指定任务的进度。不花钱。 */
    getQueueStatus: tool({
      description: '查看当前队列情况，以及指定任务的进度和失败原因',
      inputSchema: z.object({
        generationIds: z
          .array(z.string())
          .max(20)
          .optional()
          .describe('要看具体哪些任务；不给就只返回队列概览'),
      }),
      execute: async ({ generationIds }) => {
        const [stats, items] = await Promise.all([
          getQueueStats(sessionId),
          generationIds?.length
            ? getQueueItems(sessionId, generationIds)
            : Promise.resolve([]),
        ])

        return { stats, items }
      },
    }),

    /**
     * 列出最近的生成结果，供"上次那件呢""再来一次那个发型"这类追问。
     *
     * 只返回归属校验过的结果，并且只给已经产出成品的那些 ——
     * 半路失败的任务在这里没有意义，它们的失败原因由 getQueueStatus 负责解释。
     */
    listRecentResults: tool({
      description:
        '列出用户最近成功的生成结果。每条含结果图链接、当时用的模型与花费，' +
        '以及那件衣服的识别结果（garmentTitle / garmentColor）—— ' +
        '回答"上次那件怎么样"时直接复述这些描述，不要只说 id',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(20).default(5).describe('最多返回几条'),
      }),
      execute: async ({ limit }) => ({
        /*
         * 与界面的「最近结果」区共用同一条查询（见 `generation/results.ts`）。
         * 两边各写一份的话，一边补了字段、另一边没补，表现就是
         * "对话里问得到、界面上看不到"这种很难定位的差异。
         *
         * 这里只列成功：工具的用途是回答"上次那件呢"，
         * 半路失败的任务在这里没有意义，它们的失败原因由 getQueueStatus 负责解释。
         */
        results: await listRecentResults(sessionId, { limit, statuses: ['succeeded'] }),
      }),
    }),

    /**
     * 成本播报 —— 用的是用户自己的 Key，**看得见才敢用**。
     *
     * 不花钱，所以不在审批闸门里。它读的是 `costs.ts` 那份汇总，
     * 而那份汇总与失败卡片用的是**同一个**"计费没计费"判断 ——
     * 看板与卡片给出不同说法，比两个都错还糟。
     */
    getCostSummary: tool({
      description:
        `统计用户最近 ${DEFAULT_WINDOW_DAYS} 天在生成上的花费（默认）以及花在哪些模型上。不花钱。` +
        '返回值里 chargedUsd 是**确实花掉的钱**，chargedFailureCount 是花钱了却没拿到图的笔数，' +
        'uncertainCount 是无法确定是否计费的失败笔数 —— ' +
        '**最后这个数字不要并进总额，也不要当成 0**，如实说"这部分不确定"',
      inputSchema: z.object({
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .default(DEFAULT_WINDOW_DAYS)
          .describe('往前统计多少天'),
      }),
      execute: async ({ days }) => getCostSummary(sessionId, { days }),
    }),

    /**
     * 列出用户上传过的图片。不花钱。
     *
     * **这个工具解决的是一个真实的失败**：assetId 只活在消息里
     * （见 `lib/chat/annotations.ts`）。于是用户问"我适合什么风格"时，
     * 模型一个 id 都拿不出来，只能让他重新上传 —— 而他的照片明明还在库里躺着。
     *
     * ⚠️ 对话落库之后这条理由**变窄了，但没有消失**：消息现在会往返，
     * 刷新不再丢 id。可 id 只在**这一次对话**里，用户开一次新对话、
     * 或那张图是在别的对话里传的，模型手里就还是没有它。
     * 这个工具回答的是"我这个会话传过什么"，比任何一次对话都活得久。
     *
     * `usage` 是从**实际用途**反推的（当过人物照 / 被衣橱引用过），
     * 因为 `assets` 表刻意不区分这两种角色。没被用过的就是 `unused`，
     * 工具如实说不知道，让模型去问，而不是猜一个。
     */
    listRecentPhotos: tool({
      description:
        '列出用户上传过的图片（最近的在前），每条含 assetId、上传时间，以及它实际被用在哪：' +
        'person（当过人物照）/ garment（被衣橱引用过）/ both / unused（还没用过）。不花钱。' +
        ' **当需要一张人物照或服装图却发现对话里没有 assetId 时，先调这个工具**，' +
        '而不是直接让用户重新上传。' +
        '注意：usage 为 unused 的图**看不出是人物照还是服装图** —— ' +
        '不要靠猜，把候选与上传时间告诉用户，让他确认用哪一张',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(20).default(10).describe('最多返回几张'),
      }),
      execute: async ({ limit }) => {
        const photos = await listRecentPhotos(sessionId, { limit })

        return {
          photos,
          hint:
            photos.length === 0
              ? '这个用户还没有上传过任何图片，只能请他先上传'
              : '有历史照片时，先问他"用之前那张还是重新传一张"，不要直接要求重传',
        }
      },
    }),
  }
}

/** 可用模型清单，用于回答"用哪个模型、多少钱"这类问题 */
export function describeAvailableModels() {
  return {
    tryon: listModels('tryon').map((m) => ({
      id: m.id,
      label: m.label,
      tier: m.tier,
      costUsdPerRun: m.costUsdPerRun,
      license: m.license,
    })),
    hair: listModels('hair').map((m) => ({
      id: m.id,
      label: m.label,
      tier: m.tier,
      costUsdPerRun: m.costUsdPerRun,
      license: m.license,
    })),
  }
}
/**
 * 按件裁图 —— 把整身照里的每一件衣服单独裁出来，登记进衣橱。
 *
 * ⚠️ **当前不在 `createAgentTools` 里注册，模型调不到它。**
 *
 * 原因：定位用的是通用视觉模型的坐标估计，实测精度不够 —— 上装的框会把脸
 * 一起裁进去。收紧提示词与「用头部框夹取」两条修法都试过并证伪（夹紧则切掉
 * 衣领）。而裁出来的图会直接喂给付费的试穿上游，让一条已知会产坏产物的路径
 * 留在线上不符合这个项目的标准。三次产物对比见 `spike-output/crops/`。
 *
 * **接回来的办法**：在 `createAgentTools` 的返回对象里加一行
 * `cropGarment: createCropGarmentTool(ctx),` 即可 —— 实现、单测与卡片渲染
 * 都还在原地。前提是先把定位换成专门的服装分割端点。
 */
export function createCropGarmentTool(ctx: AgentToolContext) {
  const { sessionId } = ctx

  return tool({
      description:
        '把一张整身照里**每一件可以单独试穿的服装**分别裁出来，登记到用户的衣橱，返回每件的 garmentId。' +
        '不花钱、不生成新图（裁图在本机做）。' +
        '用户发来一张别人穿的整套穿搭、想试穿其中某一件时用这个 —— 裁出来的每一件都能直接拿去试穿。' +
        `一张照片最多裁 ${CROP_MAX_ITEMS} 件；框太小或不成形的会被跳过。` +
        '**返回里的 skipped 必须如实告诉用户**，不要只报成功的那几件。',
      inputSchema: z.object({
        assetId: z.string().describe('整身照的 assetId：能看清这个人身上穿了什么的那张图'),
      }),
  execute: async ({ assetId }) => {
    const { file } = await loadOwnedImage(sessionId, assetId)

    const { object } = await generateObject({
      model: getAgentModel(),
      schema: cropGarmentSchema,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: CROP_PROMPT },
                { type: 'file', data: file.body, mediaType: file.mime },
              ],
            },
          ],
        })

        const created: { garmentId: string; title: string; color: string; imageUrl: string }[] = []
        const skipped: { title: string; reason: string }[] = []

        for (const item of object.items) {
          /*
           * 每次调用都新建衣橱条目，**刻意不查缓存**（与 identifyGarment 一致）。
           *
           * 裁图在本机做、不花钱，所以重复调用最坏的结果是多几条能删掉的条目；
           * 反过来，如果缓存了结论，「这个框裁歪了，重裁一次」就永远拿不到新结果 ——
           * 那比多几条条目糟得多，因为用户没有任何办法自救。
           */
          const cropped = await cropImage(file.body, item.box)

          /*
           * 框不成立就跳过，但**不能安静地丢**：用户会以为自己要的那件已经在衣橱里了，
           * 然后一直在里面找一件不存在的衣服。所以放进返回值让模型说出来。
           */
          if (!cropped) {
            skipped.push({ title: item.title, reason: '框太小或不成形，裁不出可用的图' })
            continue
          }

          const cropAssetId = crypto.randomUUID()
          const storageKey = buildStorageKey('crops', sessionId, cropAssetId, 'jpg')
          // 先落盘再写库：反过来的话，put 失败会留下一条指向不存在文件的资产
          const stored = await storage.put(storageKey, cropped.buffer, { mime: cropped.mime })

          await db.insert(assets).values({
            id: cropAssetId,
            sessionId,
            // 不是用户传的、也不是花钱生成的，单独一类，见 ASSET_KINDS 的注释
            kind: 'derived',
            storageKey: stored.key,
            mime: cropped.mime,
            width: cropped.width,
            height: cropped.height,
            bytes: cropped.buffer.byteLength,
          })

      /*
       * id 在这里生成、**不用 `.returning()` 读回来**：`garments` 的 title / color
       * 在库里是可空列，读回来会变成 `string | null`，而这两个值就是我们上一行
       * 刚写进去的、由 schema 保证非空的东西。绕开这一圈，返回给模型的是确定的
       * 那份值，而不是一个需要它去猜「null 是什么」的对象。
       */
      const garmentId = crypto.randomUUID()
      await db.insert(garments).values({
        id: garmentId,
        sessionId,
        assetId: cropAssetId,
        title: item.title,
        color: item.color,
        /*
         * 恒为「穿在人身上」：框是从一张真人照里量出来的，不是平铺拍摄。
         * 这是本工具**已经知道的事实**，不该再花一次模型调用去问。
         */
        photoType: 'model',
      })

      created.push({
        garmentId,
        title: item.title,
        color: item.color,
        imageUrl: storage.url(stored.key),
      })
        }

        return { created, skipped, detected: object.items.length }
      },
    })
    }
