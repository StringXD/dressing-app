/**
 * 单测的最小环境。
 *
 * 必须跑在任何测试模块**导入之前** —— `src/lib/env.ts` 在模块加载时就会
 * 校验并冻结配置，晚一步设置就来不及了。vitest 的 setupFiles 正好是
 * 这个时序：先于所有测试文件执行。
 *
 * 用 `??=` 而非直接赋值：如果 shell 或 CI 已经提供了真值，不要覆盖它。
 */

// env.ts 里唯一"启动必需"的变量，缺失会让整个进程起不来
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/dressing_test'

// 生成类功能的功能性 Key。这里给假值即可 —— 单测从不真的调用 fal，
// 只验证参数映射与状态机，网络层由注入的假 client 替代。
process.env.FAL_KEY ??= 'test-fal-key-not-used'
