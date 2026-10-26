import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'

import { db } from '@/lib/db'
import { assessments, type AssessmentKind } from '@/lib/db/schema'

/**
 * 形象分析的结论形状与读写。
 *
 * 三条贯穿本文件的原则：
 *
 * 1. **提示词只允许描述看得到的东西，且必须给出建议而非评价身材。**
 *    体型与季型是主观判断，措辞不当会变成对用户的冒犯（"你太胖了"）。
 *    所以提示词明确要求产出**版型与配色建议** —— 那才是用户来做这件事的目的。
 *
 * 2. **同一个对象上的同一种分析只算一次。** 结论落库，下次直接读回并如实说明
 *    这是上次的结论。用户不该为同一个答案反复付钱，"问了才评"不等于
 *    "每次问都重新评"。
 *
 * 3. **缓存命中必须如实告知。** 把上次的结论说成刚算的，用户会以为模型
 *    重新看过图、可能高估它的新鲜度（比如刚换了发型）。
 */

const RATING_HINT = '只描述你确实看到的，不要脑补品牌、材质或价格；看不清就说不确定。'

export const critiqueSchema = z.object({
  fit: z.object({
    rating: z
      .enum(['too-tight', 'snug', 'good', 'loose', 'too-loose'])
      .describe('这件衣服在身上的合身程度'),
    notes: z.string().min(1).describe('一句话说明判断依据，看的是哪些地方（肩线、袖长、腰身、裤长）'),
  }),
  color: z.object({
    rating: z
      .enum(['clashing', 'acceptable', 'good', 'excellent'])
      .describe('衣服颜色与这个人（肤色、发色）及整体效果的协调程度'),
    notes: z.string().min(1).describe('一句话说明为什么，指出具体的颜色关系'),
  }),
  highlights: z.array(z.string()).max(5).describe('这次效果好的地方，中文短句'),
  suggestions: z
    .array(z.string())
    .max(5)
    .describe('具体可执行的改进，例如「换小一码」「试试米白色」「裤长改短两公分」；不要写空泛的「可以更好」'),
})
export type Critique = z.infer<typeof critiqueSchema>

export const bodyShapeSchema = z.object({
  shape: z
    .enum(['pear', 'apple', 'hourglass', 'rectangle', 'inverted-triangle'])
    .describe('体型类型'),
  notes: z.string().min(1).describe('一句话说明判断依据，看的是肩、腰、胯的相对宽度'),
  recommendedCuts: z
    .array(z.string())
    .max(5)
    .describe('适合的版型与剪裁，具体到单品类型，例如「高腰直筒裤」「V 领上衣」'),
  avoidCuts: z.array(z.string()).max(5).describe('建议避开的版型，同样具体'),
})
export type BodyShape = z.infer<typeof bodyShapeSchema>

export const colorSeasonSchema = z.object({
  season: z.enum(['spring', 'summer', 'autumn', 'winter']).describe('色彩季型'),
  notes: z.string().min(1).describe('一句话说明判断依据，看的是肤色冷暖、发色与瞳色'),
  recommendedColors: z.array(z.string()).max(6).describe('适合的颜色，中文颜色名'),
  avoidColors: z.array(z.string()).max(6).describe('建议避开的颜色，中文颜色名'),
})
export type ColorSeason = z.infer<typeof colorSeasonSchema>

export const lookSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().min(1).describe('单品是什么，一句中文，例如「米白色高腰阔腿裤」'),
        color: z.string().min(1).describe('主色，中文'),
        category: z
          .enum(['top', 'outerwear', 'bottom', 'shoes', 'bag', 'accessory', 'dress'])
          .describe('单品类别'),
      }),
    )
    .max(12)
    .describe('图中能看到的全部单品'),
  overall: z.string().min(1).describe('这套搭配整体是什么风格，一句话'),
})
export type Look = z.infer<typeof lookSchema>

/**
 * 风格建议的产出。
 *
 * 与上面四个 schema 的根本差别：**它是推导出来的，不是看出来的。**
 * 输入是已经存好的体型与季型结论，模型不接触任何图片。
 * 所以它不落库 —— 见 `suggestStyle` 工具里的说明。
 */
export const styleSuggestionSchema = z.object({
  direction: z.string().min(1).describe('整体风格方向，一句话，要具体到可执行的取向'),
  combinations: z
    .array(
      z.object({
        items: z.array(z.string()).min(2).max(6).describe('一套组合，列出各件单品'),
        why: z.string().min(1).describe('为什么这套适合这个人，要引到具体的体型或季型依据'),
      }),
    )
    .min(1)
    .max(3)
    .describe('具体搭配组合，1–3 套'),
  avoid: z.array(z.string()).max(5).describe('建议避开的元素，中文短句'),
})
export type StyleSuggestion = z.infer<typeof styleSuggestionSchema>

export const comparisonSchema = z.object({
  verdict: z.string().min(1).describe('总体结论：这几张里哪一张最值得留，一句话'),
  differences: z
    .array(
      z.object({
        generationId: z.string().describe('对应哪一次生成，原样照抄传进来的 id'),
        betterAt: z.array(z.string()).max(4).describe('这一张相对其他几张好在哪'),
        worseAt: z.array(z.string()).max(4).describe('相对差在哪'),
      }),
    )
    .max(8)
    .describe('逐张的差异，每次生成一条'),
  recommendation: z.string().min(1).describe('下一步建议：留哪张、还值得再试什么'),
})
export type Comparison = z.infer<typeof comparisonSchema>

/**
 * 输入照片的内容检查。
 *
 * 与其它 schema 的差别：它判断的**不是用户这个人**，而是这张图能不能用。
 * 所以问题都围绕"换装模型能不能在它上面工作"，而不是"好不好看"。
 */
export const photoCheckSchema = z.object({
  hasPerson: z.boolean().describe('图里有没有一个真人（模特、人台、合成图、剪影都不算）'),
  framing: z
    .enum(['full-body', 'half-body', 'headshot', 'unclear'])
    .describe('人的取景范围：全身 / 半身 / 头部特写 / 看不出来'),
  clarity: z.enum(['sharp', 'soft', 'blurry']).describe('这张图清不清晰'),
  notes: z.string().min(1).describe('一句话说明判断依据，只写你确实看到的'),
  advice: z
    .array(z.string())
    .max(4)
    .describe('给用户的具体建议，例如「换一张光线更均匀的」「拍的时候把脚也拍进去」；没问题就留空'),
})
export type PhotoCheck = z.infer<typeof photoCheckSchema>

export const PHOTO_CHECK_PROMPT = `你在帮用户检查一张准备用来做换装的照片。看这张图，回答四件事：

1. 图里有没有一个真人
2. 取景是全身、半身、还是只有头
3. 清不清晰
4. 如果要重拍或换一张，该注意什么

背景（判断时请照此把握）：换装模型会对人物图做姿态检测，需要看到**全身**。
半身照、坐姿照、合成图、剪影会直接失败；图小或很糊则生成结果的细节也会跟着糊。

${RATING_HINT}
不要评价这个人好不好看、胖瘦如何 —— 你判断的是**这张图能不能用**。`

export const CRITIQUE_PROMPT = `你在帮用户评估一次换装生成的结果。看这张图，回答四件事：

1. 衣服合不合身（肩线、袖长、腰身、裤长这些地方对不对）
2. 衣服的颜色与这个人搭不搭
3. 这次哪些地方做得好
4. 具体可以怎么改

${RATING_HINT}
建议要具体到能直接执行（"换小一码"），不要写"可以更好"这种没法照做的话。`

export const BODY_SHAPE_PROMPT = `你在帮用户挑选版型。看这张全身照，判断体型类型，并给出**版型建议**。

${RATING_HINT}

重要：你的任务是给出**适合与不适合的剪裁**，不是评价身材好坏。
不要使用任何带贬义的词，也不要评论胖瘦 —— 用户要的是"我该穿什么"，不是被评判。`

export const COLOR_SEASON_PROMPT = `你在帮用户挑选颜色。看这张照片，从肤色冷暖、发色与瞳色判断色彩季型，并给出**配色建议**。

${RATING_HINT}

重要：你的任务是给出**适合与建议避开的颜色**，不是评价外貌。`

export const LOOK_PROMPT = `你在帮用户记录一套穿搭。看这张图，把能看到的单品逐个列出来（上衣、外套、裤子/裙子、鞋、包、配饰），并说明整套是什么风格。

${RATING_HINT}
只列图里真的看得到的单品，看不到的类别不要凭空补。`

export const STYLE_PROMPT = `你在帮用户定整体风格方向。下面会给你两段已经分析好的结论：这个人的体型，以及色彩季型。请综合它们与用户要去的场合，给出**风格方向**与**具体搭配组合**。

要求：
- 每一套搭配都要说清"为什么适合这个人"，依据要引到上面那段体型或季型结论上，不要写"这样很好看"。
- 组合里写具体的单品与颜色（"高腰直筒牛仔裤 + 米白针织衫"），不要写"休闲风上衣"。
- 建议避开的元素同样要具体，并且和上面的结论一致 —— 不要一边说适合暖色一边让人避开橙色。
- 不要评价身材好坏，不要提"遮丑""显瘦"这类说法。用户要的是"我该穿什么"。`

export const COMPARE_PROMPT = `你在帮用户对比几次换装生成的结果。下面会给你同一批生成的产物图，按顺序排列，每张图前面会标出它的 generationId。

逐张看，然后回答：
1. 总体哪一张最值得留
2. 每一张相对其他几张好在哪、差在哪（合身度、配色、与本人气质的契合、细节完成度）
3. 下一步建议

differences 里每条都要原样照抄给你的 generationId，不要自己编 id，也不要漏掉任何一张。
只描述你确实看到的，看不清的地方说看不清，不要脑补。`

/** 结论挂在哪个对象上。由 kind 决定用哪个字段，与表上的约定一致。 */
export interface AssessmentTarget {
  kind: AssessmentKind
  /** critique 用 */
  generationId?: string
  /** body / season / look 用 */
  assetId?: string
}

export interface StoredAssessment {
  payload: Record<string, unknown>
  createdAt: Date
  modelId: string
}

/**
 * 读回已有结论。
 *
 * 认领条件里带 `sessionId`：不校验的话，任何人拿到一个 generationId
 * 就能读出别人被怎么评价的 —— 那比泄露图片更难受，评价是主观判断。
 */
export async function findAssessment(
  sessionId: string,
  target: AssessmentTarget,
): Promise<StoredAssessment | null> {
  const match = target.generationId
    ? eq(assessments.generationId, target.generationId)
    : target.assetId
      ? eq(assessments.assetId, target.assetId)
      : null

  if (!match) return null

  const [row] = await db
    .select({
      payload: assessments.payload,
      modelId: assessments.modelId,
      createdAt: assessments.createdAt,
    })
    .from(assessments)
    .where(
      and(
        eq(assessments.sessionId, sessionId),
        eq(assessments.kind, target.kind),
        match,
      ),
    )
    .orderBy(desc(assessments.createdAt))
    .limit(1)

  return row ?? null
}

/**
 * 落库。
 *
 * `onConflictDoNothing` 兜住的是**并发重复分析**：两个人（或两次点击）同时
 * 对着同一个对象发起分析时，缓存读取都会落空，于是都去调模型，
 * 回来的插入会撞上部分唯一索引。此时静默跳过即可 —— 第一个写入的结论
 * 已经在那里了，用户也已经付过一次钱了。让第二个请求报错反而更糟：
 * 钱花了，用户却看到一个失败。
 */
export async function recordAssessment(
  sessionId: string,
  target: AssessmentTarget,
  modelId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(assessments)
    .values({
      id: crypto.randomUUID(),
      sessionId,
      kind: target.kind,
      generationId: target.generationId ?? null,
      assetId: target.assetId ?? null,
      modelId,
      payload,
    })
    .onConflictDoNothing()
}
