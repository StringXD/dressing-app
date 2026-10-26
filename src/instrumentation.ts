/**
 * Next.js 启动钩子。`register()` 在 server 实例初始化时**恰好调用一次**。
 *
 * 这里只做一件事：把注册表里的禁商用（research）模型打出来。
 *
 * 为什么要有这个文件：政策允许收录 `research` 条目（效果优先），代价是使用者
 * 可能没注意到自己在用一个禁商用的模型。README 里有一张表，但挡不住"直接
 * clone 就跑起来"的人 —— 他们不会去翻文档，却一定会看到启动日志。
 *
 * 换句话说，**主动提醒是这条政策的组成部分，不是可选项**。
 * 只把 license 字段填对而没人看见，等于什么都没做。
 */
export async function register(): Promise<void> {
  // 只在 Node runtime 打。注册表本身是纯数据、Edge 里也能 load，
  // 但告警在一个进程里打一次就够，而真正调上游生成的是 Node 侧。
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // 动态 import 而不是顶层 static import：避免把 providers 拖进 Edge bundle
  const { licenseWarningText } = await import('@/lib/providers/registry')

  const warning = licenseWarningText()
  if (warning) console.warn(`[web] 模型授权警告：\n${warning}`)
}
