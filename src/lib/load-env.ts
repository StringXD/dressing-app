/**
 * 在任何模块之前加载 .env。**必须在入口文件的第一条 import 位置引用。**
 *
 * ESM 会先求值所有 import，再执行模块体。所以把 `process.loadEnvFile('.env')`
 * 直接写在入口的模块体里是**来不及的** —— `@/lib/env` 在它上面的 import 链里
 * 就已经求值并抛错了。这就是本文件必须独立存在的原因。
 *
 * 用 Node 内置能力读取，省掉 dotenv 依赖。
 */
try {
  process.loadEnvFile('.env')
} catch {
  // 没有 .env 就用进程已有的环境变量（CI / 生产），
  // 真正缺少必需项时由 @/lib/env 给出可读的报错
}

export {}
