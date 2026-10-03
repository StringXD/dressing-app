import { loadEnvFile } from 'node:process'

import { defineConfig } from 'drizzle-kit'

// drizzle-kit 不会自动加载 .env。用 Node 内置能力读取，省掉 dotenv 依赖。
try {
  loadEnvFile('.env')
} catch {
  // .env 不存在时静默跳过，让下面的显式校验给出更明确的提示
}

const url = process.env.DATABASE_URL
if (!url) {
  throw new Error(
    '缺少 DATABASE_URL。请先 `cp .env.example .env`，再 `docker compose up -d postgres`。',
  )
}

export default defineConfig({
  dialect: 'postgresql',
  // 注意：schema 里所有列都显式写了 snake_case 名字，
  // 因此这里和 db 客户端都**不设** casing，避免两处规则不一致导致列名错位。
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
  verbose: true,
  strict: true,
})
