/**
 * 上游失败码里哪些值得重试。
 *
 * 默认**不重试**：重试内容风控这类确定性拒绝只会多花一次钱，
 * 而且用户等更久。宁可少重试，也不要盲目重试。
 *
 * 定义放在这个模块而不是 `process.ts`：下面的 `explainGenerationError` 要用
 * 同一份判断，两边各写一份迟早会漂移。本模块**没有任何 import**，
 * 因此客户端组件也能安全引用（不会把 DB、存储、provider 拖进浏览器包）。
 */
export function isRetryableCode(code: string): boolean {
  return (
    code === 'status_request_failed' ||
    code === 'result_request_failed' ||
    code === 'output_download_failed' ||
    code === 'poll_timeout' ||
    /^http_5\d\d$/.test(code) ||
    code === 'http_429'
  )
}

/**
 * 这次失败对钱包意味着什么。
 *
 * 用三态而不是 boolean：**不确定时必须能如实说"不确定"**。
 * 把"可能计费了"说成"没花钱"是误导；把"没花钱"说成"可能计费了"是无谓的惊吓。
 */
export type CostImpact = 'none' | 'charged' | 'unknown'

/** 一次失败该向用户交代的三件事：出了什么事、我能做什么、花没花钱。 */
export interface ErrorExplanation {
  /** 发生了什么。一句话，直接展示给用户，不含堆栈与英文原文 */
  title: string
  /** 接下来能做什么。始终是**用户能执行的动作** */
  action: string
  cost: CostImpact
}

/**
 * 把 `(errorCode, errorMessage)` 翻译成给用户看的解释。
 *
 * **刻意做成纯函数、而不是在失败时把中文写进 DB**，三个理由：
 *  - `generations.errorMessage` 保留上游原文，排查时不受文案改动影响
 *  - 改文案不需要迁移，且对**已经在库里的历史失败行**立即生效
 *  - 纯函数可以直接单测，不必连数据库
 *
 * `code` 为空时返回 null —— 没有失败可解释（例如成功的任务）。
 *
 * ⚠️ 这里**不判断"系统还会不会自动重试"**。那件事无法只凭错误码决定：
 * 可重试错误在 pg-boss 重试预算耗尽后，DB 行仍停在 `queued`
 * （`process.ts` 的可重试分支只把行退回 queued 就抛出了，没有任何代码把
 * pg-boss 最终的失败态同步回来）。所以 `queued` 未必等于"还会重试"，
 * 要显示重试状态得先补上那个同步。
 */
export function explainGenerationError(
  code: string | null | undefined,
  message: string | null | undefined,
): ErrorExplanation | null {
  if (!code) return null

  const detail = message ?? ''

  // ── 输入被拒 ──────────────────────────────────────────────
  if (code === 'http_422') {
    // 实测：FASHN 会对人物图跑姿态检测，非真人照（合成图、剪影、坐姿、半身）
    // 直接 422，错误体形如 `body.person_image: Failed to detect body pose in model image.`
    // 这是**生产里必然会遇到**的一种，因为用户上传半身照是常态。
    if (/body pose/i.test(detail)) {
      return {
        title: '这张人物照里没有检测到完整的人体姿态',
        action:
          '换一张正面站立的全身照重试：从头顶到脚都要在画面内，光线充足，不要坐姿、侧身或只拍上半身。',
        // 实测确认：FASHN 的 422 发生在生成之前，不计费
        cost: 'none',
      }
    }

    return {
      title: '上游拒收了这次输入',
      action: '换一张更清晰的照片再试。若换图仍然失败，请保留这张原图以便反馈。',
      // 422 是"无法处理该输入"，上游未产出结果。注：这一点在 FASHN 上实测确认，
      // 其余端点沿用同一判断，若将来发现例外再单独收紧。
      cost: 'none',
    }
  }

  // ── 认证 / 授权：这是部署者的问题，不是用户照片的问题 ──────────
  if (code === 'http_401' || code === 'http_403') {
    return {
      title: 'fal API Key 无效，或没有该模型的权限',
      action: '这是部署配置问题，换照片不会好。请检查 .env 里的 FAL_KEY 是否有效、是否有该端点的访问权限。',
      cost: 'none',
    }
  }

  // ── 端点不存在 ────────────────────────────────────────────
  // fal 的目录**确实会删条目**（`fal-ai/kolors-virtual-try-on` 已消失）。
  // 对自托管项目来说，"模型下架了"是必然会发生的一类失败，值得单独说清。
  if (code === 'http_404') {
    return {
      title: '上游没有这个模型端点',
      action:
        '该模型多半已从 fal 下架。请检查 models.config.ts 里这个条目的 endpoint 是否仍然有效，并在注册表里换一个可用档位。',
      cost: 'none',
    }
  }

  // ── 限流 ─────────────────────────────────────────────────
  if (code === 'http_429') {
    return {
      title: '触发了上游的并发限制',
      action: '稍等一会儿再试。批量任务会依次排队，不必反复提交。',
      cost: 'none',
    }
  }

  // ── 上游故障 ──────────────────────────────────────────────
  if (/^http_5\d\d$/.test(code)) {
    return {
      title: '上游服务暂时故障',
      action: '这类故障通常是暂时的，过几分钟重新提交一次即可。',
      cost: 'none',
    }
  }

  // ── 其余 4xx：上游明确拒绝了请求 ───────────────────────────
  if (/^http_4\d\d$/.test(code)) {
    return {
      title: '上游拒绝了这次请求',
      action: '换一张照片再试；若换了仍然失败，请带上任务 id 提 issue。',
      cost: 'none',
    }
  }

  // ── 我方与上游之间的通信 ────────────────────────────────────
  if (code === 'status_request_failed' || code === 'result_request_failed') {
    return {
      title: '查询上游任务时通信中断',
      action: '这是网络问题，与照片无关。稍后重新提交一次即可。',
      // 可能已经生成并计费，只是我们没取到 —— 不猜
      cost: code === 'result_request_failed' ? 'unknown' : 'none',
    }
  }

  if (code === 'user_timeout') {
    return {
      title: '上游判定这次调用超时',
      action: '稍后重新提交一次。若反复超时，换一张分辨率更低的照片试试。',
      cost: 'unknown',
    }
  }

  if (code === 'poll_timeout') {
    return {
      title: '等待结果超过了时限',
      action: '上游可能仍在排队。稍后重新提交一次即可。',
      cost: 'unknown',
    }
  }

  // ── 最尖锐的一种：图已经出来了，只是没搬回来 ────────────────────
  if (code === 'output_download_failed') {
    return {
      title: '图已经生成，但下载回本地存储时失败了',
      action: '重新提交一次即可。重试会复用同一个上游任务，不会重复计费。',
      // process.ts 记录了实测结论：上游那边图已生成并计费，只是我们没下载成功
      cost: 'charged',
    }
  }

  // ── 我们自己这一侧 ─────────────────────────────────────────
  if (code === 'enqueue_failed') {
    return {
      title: '任务没能进入队列',
      action: '重新提交一次。若持续失败，多半是队列服务没起来，请检查 worker 是否在运行。',
      cost: 'none',
    }
  }

  if (code === 'internal_error') {
    return {
      title: '出现了未预期的内部错误',
      action: '重新提交一次；若反复出现，请带上任务 id 提 issue。',
      cost: 'unknown',
    }
  }

  // 兜底：上游新增了我们没见过的错误码时，至少不要说错
  return {
    title: `生成失败（${code}）`,
    action: '重新提交一次；若反复出现，请带上任务 id 提 issue。',
    cost: 'unknown',
  }
}
