import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { licenseWarningText } = vi.hoisted(() => ({
  licenseWarningText: vi.fn<() => string | null>(),
}))

vi.mock('@/lib/providers/registry', () => ({ licenseWarningText }))

/**
 * `register()` 只有五行，但它是"允许收录 research 条目"这条政策**唯一的出口**：
 * 导出名写错、守卫条件写反、忘了调用，都会让告警永远不出现，
 * 而 `licenseWarningText()` 自己的单测仍然是绿的（它确实正确，只是没人调用）。
 *
 * 所以这里测的不是文本生成，而是**有没有真的把话说到人眼前**。
 */
describe('web 启动告警', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    licenseWarningText.mockReset()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
    vi.unstubAllEnvs()
  })

  it('Node runtime 下把告警打出来', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    licenseWarningText.mockReturnValue('y/premium 禁商用')

    const { register } = await import('./instrumentation')
    await register()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('y/premium 禁商用')
  })

  it('没有非商用条目时保持安静，不刷无用的启动日志', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    licenseWarningText.mockReturnValue(null)

    const { register } = await import('./instrumentation')
    await register()

    expect(warn).not.toHaveBeenCalled()
  })

  it('非 Node runtime 直接跳过，连注册表都不加载', async () => {
    // Next 会在每个 runtime 都调一次 register()。Edge 侧既不需要这条告警，
    // 也不该为了它把 providers 拖进 Edge bundle。
    vi.stubEnv('NEXT_RUNTIME', 'edge')
    licenseWarningText.mockReturnValue('无论如何都不该被打印')

    const { register } = await import('./instrumentation')
    await register()

    expect(warn).not.toHaveBeenCalled()
    expect(licenseWarningText).not.toHaveBeenCalled()
  })
})
