import { resolve } from 'node:path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // 在测试模块导入前备好 DATABASE_URL / FAL_KEY（env.ts 加载时即校验）
    setupFiles: ['./tests/setup-env.ts'],
    // 图片处理是 CPU 密集的，并行跑多个 sharp 用例反而更慢
    pool: 'forks',
  },
  resolve: {
    // 与 tsconfig 的 paths 保持一致
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
})
