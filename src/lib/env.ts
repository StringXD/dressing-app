import { z } from 'zod'

/**
 * 环境变量分两类：
 *
 * 1. **启动必需**（只有 DATABASE_URL）—— 缺失直接让进程起不来，
 *    因为任何功能都跑不了，早失败比运行到一半报错好。
 * 2. **功能必需**（各 API Key）—— 缺失不影响启动，只在真正调用该功能时
 *    通过 requireEnv() 抛出可读错误。这样在还没拿到 Key 的阶段，
 *    骨架、界面、单测都能正常开发。
 */

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === '' ? undefined : v))

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // ── 数据库 ────────────────────────────────────────────────
  DATABASE_URL: z.string().min(1, 'DATABASE_URL 不能为空（见 .env.example）'),

  // ── 图像生成 ──────────────────────────────────────────────
  FAL_KEY: optionalString,

  // ── Agent / 视觉识别 ──────────────────────────────────────
  ANTHROPIC_API_KEY: optionalString,
  DEEPSEEK_API_KEY: optionalString,

  // ── 链接解析 ──────────────────────────────────────────────
  ONEBOUND_KEY: optionalString,
  ONEBOUND_SECRET: optionalString,
  FIRECRAWL_API_KEY: optionalString,

  // ── 存储 ─────────────────────────────────────────────────
  STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./data'),
  STORAGE_LOCAL_BASE_URL: z.string().default('/api/files'),
  R2_ACCOUNT_ID: optionalString,
  R2_ACCESS_KEY_ID: optionalString,
  R2_SECRET_ACCESS_KEY: optionalString,
  R2_BUCKET: optionalString,

  // ── 队列与配额 ────────────────────────────────────────────
  // 必须与 fal 账户的实际并发额度对齐，设大了会互相排队，设小了浪费吞吐
  FAL_CONCURRENCY: z.coerce.number().int().positive().default(2),
  DAILY_GENERATION_LIMIT: z.coerce.number().int().positive().default(30),

  // ── 合规 ─────────────────────────────────────────────────
  AI_WATERMARK_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),

  // ── 应用 ─────────────────────────────────────────────────
  APP_URL: z.string().default('http://localhost:3000'),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  · ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n')
  throw new Error(
    `环境变量校验失败：\n${issues}\n\n请对照 .env.example 检查 .env。`,
  )
}

export const env = parsed.data

/** 各功能的 Key 与"人类可读的获取方式"，用于报错时直接告诉用户去哪儿拿 */
const FEATURE_ENV = {
  FAL_KEY: 'fal.ai 控制台 https://fal.ai/dashboard/keys（需双币信用卡充值）',
  ANTHROPIC_API_KEY: 'Anthropic 控制台',
  DEEPSEEK_API_KEY: 'DeepSeek 开放平台',
  ONEBOUND_KEY: '万邦开放平台 https://open.onebound.cn（需注册询价）',
  ONEBOUND_SECRET: '万邦开放平台 https://open.onebound.cn',
  FIRECRAWL_API_KEY: 'Firecrawl 控制台 https://firecrawl.dev',
  R2_ACCOUNT_ID: 'Cloudflare R2 控制台',
  R2_ACCESS_KEY_ID: 'Cloudflare R2 控制台',
  R2_SECRET_ACCESS_KEY: 'Cloudflare R2 控制台',
  R2_BUCKET: 'Cloudflare R2 控制台',
} as const satisfies Record<string, string>

export type FeatureEnvKey = keyof typeof FEATURE_ENV

/**
 * 取一个功能必需的 Key，缺失时抛出**能指导下一步动作**的错误，
 * 而不是让调用方在更远处收到一个难以定位的 undefined。
 */
export function requireEnv(key: FeatureEnvKey): string {
  const value = env[key]
  if (!value) {
    throw new Error(`缺少环境变量 ${key}，无法继续。获取方式：${FEATURE_ENV[key]}`)
  }
  return value
}

/** 该功能是否已配置（用于界面提示"此功能未启用"而非直接报错） */
export function hasEnv(key: FeatureEnvKey): boolean {
  return Boolean(env[key])
}
