import {
  bigserial,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

import {
  GARMENT_PHOTO_TYPES,
  TASK_KINDS,
} from '@/lib/domain'

/**
 * 各表的枚举与领域概念的 const 数组来源见 `@/lib/domain`，
 * 这里只保留纯 DB 层面的枚举（状态机、资产类型）。
 */

export const GENERATION_STATUSES = [
  'queued',
  'processing',
  'succeeded',
  'failed',
  'canceled',
] as const
export type GenerationStatus = (typeof GENERATION_STATUSES)[number]

/** 终态：进入这些状态后不再变化，前端可停止轮询 */
export const TERMINAL_STATUSES: readonly GenerationStatus[] = ['succeeded', 'failed', 'canceled']

/**
 * 资产来源。
 *
 * **加值不需要迁移**：`kind` 列是裸 `text`，没有 CHECK 约束，枚举只活在 TS 里
 * （用 `\d assets` 确认过）。
 *
 * `derived` 指**在本地从别的资产算出来的**图，目前只有 cropGarment 的裁剪产物。
 * 它必须单独成一类而不能并进 `upload`：`listRecentPhotos` 按 `kind = 'upload'`
 * 反推「我传过哪些图」，把裁剪产物算进去的话，用户会在自己的照片列表里看到一堆
 * 系统刚造出来的小图 —— 而他本来是要在衣橱里看那些结果的。
 */
export const ASSET_KINDS = ['upload', 'generated', 'derived'] as const
export type AssetKind = (typeof ASSET_KINDS)[number]

export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const
export type MessageRole = (typeof MESSAGE_ROLES)[number]

/**
 * 一条消息的 parts（对应 AI SDK 的 UIMessage.parts）。
 * 这里刻意用宽松结构而非直接引用 SDK 类型，避免 DB schema 与 SDK 版本耦合。
 */
export type MessagePart = { type: string; [key: string]: unknown }

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

/**
 * 匿名会话。第一版不做登录，用 cookie 里的 sessionId 区分用户。
 * 后续加登录时在此表挂 userId 即可，业务表无需改动。
 */
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * 图片资产。上传的原图与生成的图都存在这里，只是 kind 不同。
 */
export const assets = pgTable(
  'assets',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ASSET_KINDS }).notNull(),
    /** 存储层的不透明 key，本地磁盘与 R2 共用同一套语义 */
    storageKey: text('storage_key').notNull(),
    mime: text('mime').notNull(),
    width: integer('width'),
    height: integer('height'),
    bytes: integer('bytes'),
    createdAt: createdAt(),
  },
  (t) => [index('assets_session_idx').on(t.sessionId)],
)

/**
 * 对话。personAssetId 是"当前使用的人物全身照"，
 * Agent 靠它维持上下文（用户不必每轮重发照片）。
 */
export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    personAssetId: text('person_asset_id').references(() => assets.id, {
      onDelete: 'set null',
    }),
    title: text('title'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('conversations_session_idx').on(t.sessionId)],
)

/**
 * 消息。id 与 AI SDK 的 UIMessage.id 对齐，由前端生成，
 * 这样刷新页面后 message id 保持一致，工具调用结果能正确回填。
 */
export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: MESSAGE_ROLES }).notNull(),
    parts: jsonb('parts').$type<MessagePart[]>().notNull(),
    /**
     * 会话内的顺序。
     *
     * ⚠️ **不能靠 `created_at` 排。** 一次落库是一个 INSERT，而 `now()` 返回的是
     * **事务开始时间** —— 同一批消息拿到的时间戳完全相同，按它排序的结果是任意的。
     * 表现是刷新后消息偶尔错位，而且是间歇性的，最难查的那一类。
     *
     * 这个教训项目里已经有过一次：`generations.queueSeq` 就是为了同一个原因
     * 从时间戳换成了序列号（见下方那段注释）。
     */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('messages_conversation_seq_idx').on(t.conversationId, t.seq)],
)

/**
 * 服装图。
 *
 * 取消链接解析、且入口收敛为**单一上传**之后，这里不再记录"图是从哪来的"：
 * 用户不需要声明，由模型判断图里是商品页还是服装本身（对应阶段 5 的 identifyGarment）。
 *
 * ⚠️ 该项判定的落库字段**故意暂不预留**。取值集合应当由识别步骤的真实输出决定，
 * 现在凭空猜一个枚举，只会让后来人误以为它已经定稿。等识别逻辑建好再加列，
 * 一次迁移的成本远低于一个语义错误的列。
 */
export const garments = pgTable(
  'garments',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    title: text('title'),
    color: text('color'),
    photoType: text('photo_type', { enum: GARMENT_PHOTO_TYPES }).notNull().default('unknown'),
    createdAt: createdAt(),
  },
  (t) => [index('garments_session_idx').on(t.sessionId)],
)

/**
 * 生成任务。
 *
 * queueSeq 用 bigserial：队列位置靠它做全序比较（"我前面还有几个"），
 * 时间戳在并发写入下可能相同，序列号不会。
 */
export const generations = pgTable(
  'generations',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    taskKind: text('task_kind', { enum: TASK_KINDS }).notNull(),
    status: text('status', { enum: GENERATION_STATUSES }).notNull().default('queued'),

    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),

    personAssetId: text('person_asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    /** 换装任务必填；换发型任务为空 */
    garmentId: text('garment_id').references(() => garments.id, { onDelete: 'set null' }),

    /** 已归一化的统一任务参数（TaskInput），Worker 靠它重建请求 */
    params: jsonb('params').$type<Record<string, unknown>>().notNull(),

    /** 上游任务 id：fal 的 request_id */
    providerJobId: text('provider_job_id'),
    outputAssetId: text('output_asset_id').references(() => assets.id, {
      onDelete: 'set null',
    }),

    errorCode: text('error_code'),
    errorMessage: text('error_message'),

    /** 实际成本，用于核对账单 */
    costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }),
    latencyMs: integer('latency_ms'),

    /** 全局单调递增，用于计算队列位置 */
    queueSeq: bigserial('queue_seq', { mode: 'number' }).notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('generations_session_status_idx').on(t.sessionId, t.status),
    index('generations_status_seq_idx').on(t.status, t.queueSeq),
    index('generations_conversation_idx').on(t.conversationId),
    index('generations_provider_job_idx').on(t.providerJobId),
  ],
)

/**
 * 形象分析结论：结果评价、体型、色彩季型、整套提取。
 *
 * **为什么是一张共享表而不是各加各的列**：这些结论挂在**不同对象**上
 * （评价挂一次生成，体型/季型挂一张人物照）。给 `assets` 加
 * `bodyShape`/`colorSeason` 会让一张通用的图片表长出"只对人物照有意义"的字段，
 * 而给 `generations` 加 `critique` 又解决不了另外两个。
 *
 * **为什么结论用 jsonb 而不为每种 kind 建列**：五者的字段完全不同。
 * 塞进同一组列会得到一堆永远为空的字段 —— 与 `garments` 表上那条
 * "凭空猜一个枚举只会让后来人误以为它已经定稿"是同一条理由。
 *
 * **`comparison` 为什么不并进 `critique`**：两者的 payload 形状完全不同
 * （critique 给 fit/color，comparison 给 verdict/differences），
 * 而表上的唯一索引是按 `(kind, generation_id)` 建的。共用 kind 的后果是：
 * 一次对比会占住某个 generation 的 critique 槽位，之后 `critiqueOutfit`
 * 读缓存时把对比结论当成合身度评价返回 —— 模型拿到一个字段对不上的对象，
 * 用户看到的是"评价里没有合身度"这种没法解释的现象。
 *
 * 加这个值**不需要迁移**：`kind` 列是裸 `text`，没有 CHECK 约束
 * （见 `drizzle/0003_quiet_frank_castle.sql`），枚举只活在 TS 里。
 */
export const ASSESSMENT_KINDS = [
  'critique',
  'body',
  'season',
  'look',
  'comparison',
  'photo',
] as const
export type AssessmentKind = (typeof ASSESSMENT_KINDS)[number]

export const assessments = pgTable(
  'assessments',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ASSESSMENT_KINDS }).notNull(),

    /**
     * 分析对象。二选一，由 kind 决定用哪个。
     *
     * 用 cascade 而不是 set null：一个两个外键都为空的结论行没有任何检索入口
     * （不知道该归属到谁），留着只会变成永远查不到、也永远删不掉的垃圾。
     */
    generationId: text('generation_id').references(() => generations.id, {
      onDelete: 'cascade',
    }),
    assetId: text('asset_id').references(() => assets.id, { onDelete: 'cascade' }),

    modelId: text('model_id').notNull(),
    /** 结构化结论，形状由 kind 决定 */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    /*
     * 两个**部分唯一索引**：同一个对象上的同一种分析只允许有一条。
     *
     * 这把"同一个结论不重复付费"从纪律变成了结构事实 —— 工具里的缓存读取
     * 是快路径，它才是兜底。少了它，一次并发或一处漏查就会悄悄留下第二条，
     * 而那样的错误不会有任何报错，只在账单上体现。
     *
     * 部分索引（而不是普通唯一索引）是必需的：两列各自只对部分 kind 有意义，
     * 直接建唯一索引会让所有 `asset_id IS NULL` 的行互相冲突。
     */
    uniqueIndex('assessments_asset_target_uniq')
      .on(t.kind, t.assetId)
      .where(sql`${t.assetId} is not null`),
    uniqueIndex('assessments_generation_target_uniq')
      .on(t.kind, t.generationId)
      .where(sql`${t.generationId} is not null`),
    index('assessments_session_kind_idx').on(t.sessionId, t.kind),
  ],
)

export type Session = typeof sessions.$inferSelect
export type Asset = typeof assets.$inferSelect
export type Conversation = typeof conversations.$inferSelect
export type Message = typeof messages.$inferSelect
export type Garment = typeof garments.$inferSelect
export type Generation = typeof generations.$inferSelect
export type Assessment = typeof assessments.$inferSelect
