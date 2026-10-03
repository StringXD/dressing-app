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

import {
  GARMENT_PHOTO_TYPES,
  GARMENT_SOURCE_KINDS,
  RESOLVE_TIERS,
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

export const ASSET_KINDS = ['upload', 'generated'] as const
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
    createdAt: createdAt(),
  },
  (t) => [index('messages_conversation_created_idx').on(t.conversationId, t.createdAt)],
)

/**
 * 解析出来的服装。sourceUrl 为空的记录是"用户直接发的截图"，
 * 这类没有 URL 可去重，Postgres 的 NULL 唯一性语义正好允许它们并存。
 */
export const garments = pgTable(
  'garments',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    sourceKind: text('source_kind', { enum: GARMENT_SOURCE_KINDS }).notNull(),
    sourceUrl: text('source_url'),
    /** 命中平台（taobao/jd/...），用于统计各平台的解析成功率 */
    platform: text('platform'),
    /** 命中的降级层级，取值见 @/lib/domain 的 RESOLVE_TIERS */
    resolvedBy: text('resolved_by', { enum: RESOLVE_TIERS }),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id, { onDelete: 'cascade' }),
    title: text('title'),
    color: text('color'),
    photoType: text('photo_type', { enum: GARMENT_PHOTO_TYPES }).notNull().default('unknown'),
    createdAt: createdAt(),
  },
  (t) => [
    index('garments_session_idx').on(t.sessionId),
    // 幂等：同一 session 下同一个 URL 不重复解析
    uniqueIndex('garments_session_source_url_uq').on(t.sessionId, t.sourceUrl),
  ],
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

export type Session = typeof sessions.$inferSelect
export type Asset = typeof assets.$inferSelect
export type Conversation = typeof conversations.$inferSelect
export type Message = typeof messages.$inferSelect
export type Garment = typeof garments.$inferSelect
export type Generation = typeof generations.$inferSelect
