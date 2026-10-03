/**
 * 在任何模块之前加载 .env。
 *
 * ESM 按 import 顺序求值依赖，所以只要这个 import 排在 `@/lib/db` 之前，
 * 环境变量就一定先就位 —— 否则 `env.ts` 会在模块加载时因缺 DATABASE_URL 而抛错。
 */
try {
  process.loadEnvFile('.env')
} catch {
  // 没有 .env 就用进程已有的环境变量（CI / 生产）
}

export {}
