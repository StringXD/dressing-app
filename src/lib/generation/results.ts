import { and, desc, eq, inArray } from 'drizzle-orm'

import { db } from '@/lib/db'
import { assessments, assets, garments, generations, type GenerationStatus } from '@/lib/db/schema'
import type { TaskKind } from '@/lib/domain'
import { buildCritiqueView, type CritiqueView } from '@/lib/generation/assessment-labels'
import { storage } from '@/lib/storage'

/**
 * 「最近结果」的共享查询。
 *
 * 单独抽出来是因为**界面和 Agent 工具问的是同一件事**：本会话最近生成过什么。
 * 之前这段查询只存在于 `agent/tools.ts` 的 `listRecentResults` 工具里；
 * 界面再抄一份的话，两边迟早漂移 —— 比如一边补了原图地址、另一边没补，
 * 表现就是"对话里问得到、界面上看不到"这种很难定位的差异。
 */

/** 列表里一条记录。字段与界面所需一一对应，避免界面再拼一次 */
export interface ResultView {
  generationId: string
  taskKind: TaskKind
  modelId: string
  status: GenerationStatus
  costUsd: number | null
  createdAt: Date
  /**
   * 产物图地址。
   * 没有产出时是 **null 而不是空字符串** —— `src=""` 在浏览器里会渲染成破图，
   * 或者更糟，重新请求当前页面地址。
   */
  imageUrl: string | null
  /** 人物原图地址，对比滑块的 before 侧。原图被删时为 null */
  personImageUrl: string | null
  /**
   * 用的是哪件衣服（换发型任务为空）。
   *
   * 界面目前不显示它，但 Agent 的 `listRecentResults` 工具一直返回这个字段 ——
   * 抽共享查询时若把它丢掉，就是一次没人要求、也没人会发现的行为变更。
   */
  garmentId: string | null
  /**
   * 那件衣服的识别结果：「蓝色棒球外套」。
   *
   * **光有 `garmentId` 对用户毫无用处。** 用户问"上次换的那件怎么样"时，
   * 模型手里只有一串 uuid，于是只能回答"记录里只有 id" —— 它看不到
   * `garments` 表里明明存着的款式与颜色。这两列存在的意义就是让模型
   * 能像人一样复述那件衣服，而不是逼用户去翻图。
   *
   * 换发型任务、或衣服记录已被删除时为 null。
   */
  garmentTitle: string | null
  garmentColor: string | null
  /**
   * 这次结果的合身度/配色评价，**没有评价过时为 null**。
   *
   * 只有用户主动问过（"这件合身吗"）才会有 —— 这是"问了才评"的直接体现，
   * 界面因此不能把它当成一定存在的字段。
   */
  critique: CritiqueView | null
}

/** `buildResultViews` 的输入，只取真正要用的列 */
export interface ResultRow {
  id: string
  taskKind: TaskKind
  modelId: string
  status: GenerationStatus
  costUsd: number | null
  createdAt: Date
  outputAssetId: string | null
  personAssetId: string
  garmentId: string | null
  garmentTitle: string | null
  garmentColor: string | null
}

/**
 * 把 DB 行映射成视图模型。
 *
 * 做成纯函数（不碰 db、只做一次 Map 查找）是为了让"归属过滤到底有没有生效"
 * 这件事可以被单测直接钉住 —— 而那正是**会泄露别人图片**的地方。
 */
export function buildResultViews(
  rows: ResultRow[],
  keyByAssetId: Map<string, string>,
  critiqueByGenerationId: Map<string, unknown> = new Map(),
): ResultView[] {
  return rows.map((row) => ({
    generationId: row.id,
    taskKind: row.taskKind,
    modelId: row.modelId,
    status: row.status,
    costUsd: row.costUsd,
    createdAt: row.createdAt,
    imageUrl: urlFor(row.outputAssetId, keyByAssetId),
    personImageUrl: urlFor(row.personAssetId, keyByAssetId),
    garmentId: row.garmentId,
    garmentTitle: row.garmentTitle,
    garmentColor: row.garmentColor,
    /*
     * 转换（而不是直接透传 payload）放在这里，是为了让**界面拿到的就是
     * 可以照着渲染的东西**：枚举已翻成中文、缺失项已是 null。
     * 让组件自己再解一遍结构，等于把同一套防御写两遍，而两份里总有一份会漏。
     */
    critique: buildCritiqueView(critiqueByGenerationId.get(row.id)),
  }))
}

/**
 * 查不到的 assetId 一律给 null，**不拼一个"看起来能访问"的地址**。
 *
 * 查不到有两种原因，而且都不该给出地址：
 *  1. 资产不属于本会话 —— 归属校验把它滤掉了；
 *  2. 资产已被删除。
 * 两种都会让那个 URL 返回 404。给用户一个点开就报错的链接，
 * 比明说"这张图没有了"更糟。
 */
function urlFor(assetId: string | null, keyByAssetId: Map<string, string>): string | null {
  if (!assetId) return null
  const key = keyByAssetId.get(assetId)
  return key ? storage.url(key) : null
}

export interface ListResultsOptions {
  limit: number
  /**
   * 只要哪些状态。默认只列成功。
   *
   * 界面要显式把 `failed` 也带上：`output_download_failed` 这类失败
   * **上游已经计费**，只列成功会让用户以为"没扣钱"。
   * 这与 `progress-notice.tsx` 里那套三态成本提示是同一个原则。
   */
  statuses?: readonly GenerationStatus[]
}

/**
 * 查本会话最近的生成记录。
 *
 * `sessionId` 是**必填**而不是可选：这个函数只服务"我自己看到了什么"，
 * 没有任何合理场景需要跨会话查询。做成可选迟早会有人传 undefined，
 * 那就等于把全部用户的图列出来了。
 */
export async function listRecentResults(
  sessionId: string,
  { limit, statuses = ['succeeded'] }: ListResultsOptions,
): Promise<ResultView[]> {
  if (statuses.length === 0) return []

  const rows = await db
    .select({
      id: generations.id,
      taskKind: generations.taskKind,
      modelId: generations.modelId,
      status: generations.status,
      costUsd: generations.costUsd,
      createdAt: generations.createdAt,
      outputAssetId: generations.outputAssetId,
      personAssetId: generations.personAssetId,
      garmentId: generations.garmentId,
      // 这两列是本次修复的重点：没有它们，模型只知道一串 uuid，
      // 用户问"上次那件怎么样"时答不出任何有用的东西。
      garmentTitle: garments.title,
      garmentColor: garments.color,
    })
    .from(generations)
    /*
     * 带上 sessionId 做连接条件，而不是只连 id。
     *
     * 换发型任务没有 garmentId，leftJoin 自然给 null，正是想要的。
     * 但归属仍要校验：任务是自己的，不代表它引用的衣服也是 ——
     * 这与下面资产那次二次校验是同一条原则。连不上时 title 为 null，
     * 模型会说"看不到那件衣服的描述"，而不是把别人的衣服描述出来。
     */
    .leftJoin(
      garments,
      and(eq(garments.id, generations.garmentId), eq(garments.sessionId, sessionId)),
    )
    .where(
      and(
        eq(generations.sessionId, sessionId),
        inArray(generations.status, [...statuses]),
      ),
    )
    // 队位序列号是全局单调的，比时间戳更可靠（并发写入下时间戳可能相同）
    .orderBy(desc(generations.queueSeq))
    .limit(limit)

  const assetIds = [
    ...new Set(
      rows
        .flatMap((row) => [row.outputAssetId, row.personAssetId])
        .filter((id): id is string => id !== null),
    ),
  ]

  // 第二次归属校验：任务是自己的，不代表它引用的资产也是。
  // 少了这个 eq，一个被人为改过 conversationId / 资产归属的库就能泄露别人的图。
  const keys = assetIds.length
    ? await db
        .select({ id: assets.id, storageKey: assets.storageKey })
        .from(assets)
        .where(and(inArray(assets.id, assetIds), eq(assets.sessionId, sessionId)))
    : []

  const generationIds = rows.map((row) => row.id)

  /*
   * 评价另查一次，而不是 join 进上面那条主查询。
   *
   * 一次生成**可能没有评价**（没问过就没有），用 inner join 会把这些行整条丢掉，
   * left join 又要为「一条结果最多一条 critique」再写一层去重条件。
   * 单独一条 `inArray` 查询更直白，也更好在测试里钉住它的归属过滤。
   */
  const critiques = generationIds.length
    ? await db
        .select({ generationId: assessments.generationId, payload: assessments.payload })
        .from(assessments)
        .where(
          and(
            // 归属过滤是这条查询的安全底线：少了它，别人对同一次生成写下的
            // 评价会被读出来 —— 而评价是主观判断，比泄露图片更难受
            eq(assessments.sessionId, sessionId),
            eq(assessments.kind, 'critique'),
            inArray(assessments.generationId, generationIds),
          ),
        )
    : []

  return buildResultViews(
    rows,
    new Map(keys.map((k) => [k.id, k.storageKey])),
    new Map(
      critiques
        .filter(
          (row): row is { generationId: string; payload: Record<string, unknown> } =>
            row.generationId !== null,
        )
        .map((row) => [row.generationId, row.payload]),
    ),
  )
}
