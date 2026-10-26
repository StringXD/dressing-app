import { describe, expect, it } from 'vitest'

import { explainGenerationError, isRetryableCode } from './errors'

/**
 * 实测拿到的真实错误体，**原样**放进来。
 * 别改成"想象中"的样子 —— 那样测试就只能证明我们和自己的想象一致。
 */
const FASHN_NO_POSE =
  'Unprocessable Entity — body.person_image: Failed to detect body pose in model image.'

/**
 * 系统实际会写进 `generations.error_code` 的全部取值。
 *
 * 这个列表是被测对象的一部分，不是装饰：**新增错误码却忘了写文案时，
 * 下面的「错误码覆盖」会红**。加了新码就把它加进来。
 */
const KNOWN_CODES = [
  'http_400',
  'http_401',
  'http_403',
  'http_404',
  'http_422',
  'http_429',
  'http_500',
  'http_502',
  'http_503',
  'user_timeout',
  'status_request_failed',
  'result_request_failed',
  'poll_timeout',
  'output_download_failed',
  'enqueue_failed',
  'internal_error',
] as const

describe('explainGenerationError', () => {
  it('没有错误码时返回 null —— 成功的任务不该被安上失败解释', () => {
    expect(explainGenerationError(null, null)).toBeNull()
    expect(explainGenerationError(undefined, undefined)).toBeNull()
    expect(explainGenerationError('', '')).toBeNull()
  })

  it('认出 FASHN 的姿态检测失败，给出"换全身照"这种能照做的建议', () => {
    const e = explainGenerationError('http_422', FASHN_NO_POSE)

    // 这是本项目最可能发生的一类真实失败（用户上传半身照是常态），
    // 必须与"泛泛的 422"区分开，否则等于没说
    expect(e?.title).toContain('姿态')
    expect(e?.action).toContain('全身照')
    expect(e?.cost).toBe('none')
  })

  it('非姿态的 422 不谎称知道具体原因，但仍说是输入被拒', () => {
    const e = explainGenerationError(
      'http_422',
      'Unprocessable Entity — body.garment_image: invalid image format',
    )

    expect(e?.title).toContain('拒收')
    expect(e?.title).not.toContain('姿态')
    expect(e?.cost).toBe('none')
  })

  it('鉴权失败明确指出是部署问题，别让用户去换照片', () => {
    for (const code of ['http_401', 'http_403']) {
      const e = explainGenerationError(code, 'Unauthorized')
      expect(e?.action, code).toContain('FAL_KEY')
    }
  })

  it('模型下架（404）指向注册表，因为那是自托管项目真会遇到的事', () => {
    const e = explainGenerationError('http_404', 'Not Found')
    expect(e?.title).toContain('模型端点')
    expect(e?.action).toContain('models.config.ts')
  })

  it('5xx 与 429 都归为"暂时的"，让用户再试而不是排查自己', () => {
    expect(explainGenerationError('http_503', '')?.title).toContain('故障')
    expect(explainGenerationError('http_429', '')?.title).toContain('并发')
  })

  // ── 下面两组是"钱"相关的断言。说错的代价不对称，所以要钉死 ──────────

  it('output_download_failed 必须如实说"已计费"', () => {
    // 上游那边图已生成并计费，只是我们没下载成功。
    // 这里若说成"没花钱"，就是在骗用户的钱。
    const e = explainGenerationError('output_download_failed', 'fetch failed')

    expect(e?.cost).toBe('charged')
    expect(e?.action).toContain('不会重复计费')
  })

  it('422 必须说"没计费"', () => {
    // 实测确认 FASHN 的 422 发生在生成之前。
    // 说成"可能花钱了"是无谓的惊吓。
    expect(explainGenerationError('http_422', '')?.cost).toBe('none')
  })

  it('真的不知道时就说 unknown，两边都不猜', () => {
    // 结果取不回来、等超时 —— 上游可能已经生成并计费了，我们无从判断
    for (const code of ['result_request_failed', 'poll_timeout', 'user_timeout']) {
      expect(explainGenerationError(code, '')?.cost, code).toBe('unknown')
    }
  })

  it('完全没见过的错误码也要给得出话，并带上原始码便于反馈', () => {
    const e = explainGenerationError('http_418_teapot', 'weird upstream thing')

    expect(e).not.toBeNull()
    // 带上原码，用户提 issue 时才说得清
    expect(e?.title).toContain('http_418_teapot')
    expect(e?.cost).toBe('unknown')
  })
})

describe('错误码覆盖', () => {
  it('每个已知错误码都有专门文案，不掉进兜底', () => {
    for (const code of KNOWN_CODES) {
      const e = explainGenerationError(code, '')

      expect(e, `${code} 应当有解释`).not.toBeNull()
      // 兜底文案会把错误码写进标题；专门文案不会。
      // 所以标题里出现错误码 == 这个码没有专属文案。
      expect(e?.title, `${code} 掉进了兜底文案`).not.toContain(code)
    }
  })
})

describe('isRetryableCode', () => {
  it('重试那些"再试一次可能就好了"的', () => {
    const retryable = [
      'status_request_failed',
      'result_request_failed',
      'output_download_failed',
      'poll_timeout',
      'http_500',
      'http_502',
      'http_503',
      'http_429',
    ]

    for (const code of retryable) {
      expect(isRetryableCode(code), `${code} 应当可重试`).toBe(true)
    }
  })

  it('不重试确定性拒绝 —— 重试只会让用户多等一轮', () => {
    const terminal = [
      'http_400',
      'http_401',
      'http_403',
      'http_404',
      'http_422',
      'internal_error',
      'enqueue_failed',
    ]

    for (const code of terminal) {
      expect(isRetryableCode(code), `${code} 不该重试`).toBe(false)
    }
  })

  it('错误码为空时不重试（不把未知当可重试）', () => {
    expect(isRetryableCode('')).toBe(false)
  })
})
