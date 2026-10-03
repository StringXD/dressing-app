import { hostnameOf } from './platforms'

/** 最多跟随的跳转次数。国内分享链常见 1–2 跳，给到 5 是余量。 */
const MAX_HOPS = 5

/** 单跳超时。某一跳卡住不该拖死整条链路（对话式交互对延迟很敏感）。 */
const HOP_TIMEOUT_MS = 8_000

export interface ExpandResult {
  /** 展开后的地址。即使中途失败也会返回**已经到达的那一跳**，绝不是 null */
  finalUrl: string
  hops: number
  /** 是否走完了（false 表示中途停下，finalUrl 可能仍是短链） */
  complete: boolean
  /** 中途停下的原因，供日志与对话提示 */
  detail: string
}

/**
 * 判断主机名是否安全可跟随。
 *
 * 这是**安全边界**：链接来自用户，短链可以指向任意地址。
 * 不加限制的话，一个恶意的分享链就能让我们的服务端去请求内网
 * （169.254.169.254 的云元数据、127.0.0.1 的内部服务、10.x 的内网主机）。
 * 因此按前缀黑名单式地拒绝，而不是尝试列举允许的公网段。
 */
function isSafePublicHost(host: string): boolean {
  const lower = host.toLowerCase()

  // 不带点的名字一定是内网短名（localhost、db、redis 之类）
  if (!lower.includes('.')) return false

  if (lower === 'localhost' || lower.endsWith('.localhost')) return false
  if (lower.endsWith('.local') || lower.endsWith('.internal')) return false

  // 回环 / 私有 / 链路本地 / 保留段
  if (/^127\./.test(lower)) return false
  if (/^10\./.test(lower)) return false
  if (/^192\.168\./.test(lower)) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(lower)) return false
  if (/^169\.254\./.test(lower)) return false
  if (/^0\./.test(lower)) return false

  // IPv6 回环与唯一本地地址
  if (lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd')) return false

  return true
}

/** 相对 Location 要相对当前地址解析，否则会丢掉 host */
function resolveLocation(location: string, base: string): string | null {
  try {
    return new URL(location, base).toString()
  } catch {
    return null
  }
}

/**
 * 从 HTML 里找跳转目标。
 *
 * 必须处理这种情况：国内电商的短链经常返回 **200 + 一段带 meta refresh
 * 或 JS 跳转的极小 HTML**，而不是 3xx。只认 Location 头会在这些链上失败。
 */
export function extractHtmlRedirect(html: string, base: string): string | null {
  // <meta http-equiv="refresh" content="0;url=...">
  const meta = html.match(
    /<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']?[^"'>]*?url\s*=\s*([^"';\s>]+)/i,
  )
  if (meta?.[1]) {
    const resolved = resolveLocation(meta[1].replace(/&amp;/g, '&'), base)
    if (resolved) return resolved
  }

  // window.location.href = '...' / location.replace('...') / location.href = "..."
  const js = html.match(
    /(?:window\.)?location(?:\.href)?\s*(?:=|\.replace\(\s*)\s*["']([^"']+)["']/i,
  )
  if (js?.[1]) {
    const resolved = resolveLocation(js[1], base)
    if (resolved) return resolved
  }

  return null
}

interface HopOutcome {
  nextUrl: string | null
  detail: string
}

interface ExpandOptions {
  /** 测试注入用；默认全局 fetch */
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

async function followOneHop(
  current: string,
  options: ExpandOptions,
): Promise<HopOutcome> {
  const doFetch = options.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(HOP_TIMEOUT_MS)
  const combined = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout

  let response: Response
  try {
    response = await doFetch(current, {
      // manual 而不是 follow：我们要逐跳校验目标主机，
      // 否则一个短链就能把我们引到内网地址
      redirect: 'manual',
      signal: combined,
      headers: {
        // 不带 UA 的话多数平台直接返回空页或验证页
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { nextUrl: null, detail: `请求失败：${reason}` }
  }

  // 3xx：读 Location
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')

    if (!location) {
      // undici 在某些配置下会把 manual 响应变成不透明响应：拿不到头也拿不到状态。
      // 这属于环境问题而非链接问题，要说清楚，否则排查时会被误导。
      return {
        nextUrl: null,
        detail: `返回 ${response.status} 但读不到 Location 头（可能是不透明响应）`,
      }
    }

    const resolved = resolveLocation(location, current)
    return resolved
      ? { nextUrl: resolved, detail: `跳转到 ${resolved}` }
      : { nextUrl: null, detail: `Location 无法解析：${location}` }
  }

  if (!response.ok) {
    return { nextUrl: null, detail: `HTTP ${response.status}` }
  }

  // 200：可能是最终页面，也可能是带 meta/JS 跳转的中转页。
  // 只读前 64KB —— 跳转页极小，而商品页可能几百 KB，读满纯属浪费。
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('html')) {
    return { nextUrl: null, detail: `非 HTML 响应（${contentType || '未知类型'}）` }
  }

  let snippet: string
  try {
    snippet = (await response.text()).slice(0, 64 * 1024)
  } catch (error) {
    return {
      nextUrl: null,
      detail: `读取响应体失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const htmlRedirect = extractHtmlRedirect(snippet, current)
  if (htmlRedirect) {
    return { nextUrl: htmlRedirect, detail: `页面内跳转到 ${htmlRedirect}` }
  }

  return { nextUrl: null, detail: '已到达最终页面' }
}

/**
 * 展开分享短链。
 *
 * **不会抛异常**：任何失败都以 `complete: false` + `detail` 表达，
 * 并返回已经走到的地址。解析链路上不允许有未捕获异常 ——
 * 一个坏链接最坏的结果应该是"引导用户发截图"，而不是 500。
 */
export async function expandShortLink(
  url: string,
  options: ExpandOptions = {},
): Promise<ExpandResult> {
  let current = url
  let hops = 0

  for (let i = 0; i < MAX_HOPS; i += 1) {
    const host = hostnameOf(current)

    if (!host) {
      return { finalUrl: current, hops, complete: false, detail: `地址无法解析：${current}` }
    }

    if (!isSafePublicHost(host)) {
      return {
        finalUrl: current,
        hops,
        complete: false,
        detail: `出于安全考虑不跟随内网地址：${host}`,
      }
    }

    const outcome = await followOneHop(current, options)

    if (!outcome.nextUrl) {
      // 没得跟了：要么到了终点，要么失败。两者都返回当前地址，
      // 由调用方根据 complete 决定下一步。
      const arrived = outcome.detail === '已到达最终页面'
      return { finalUrl: current, hops, complete: arrived, detail: outcome.detail }
    }

    if (outcome.nextUrl === current) {
      return { finalUrl: current, hops, complete: false, detail: '跳转指向自身，停止' }
    }

    current = outcome.nextUrl
    hops += 1
  }

  return {
    finalUrl: current,
    hops,
    complete: false,
    detail: `跟随 ${MAX_HOPS} 跳后仍未到终点，停止以避免死循环`,
  }
}

/**
 * URL 里出现的字符集合。
 *
 * 关键：必须把中日韩字符排除掉。分享文案几乎总是"链接紧跟中文"
 * （`https://item.jd.com/100.html，很好`），若只排除空白与引号，
 * 中文字符会被一并吞进 URL，得到一个必然 404 的地址。
 * URL 里的非 ASCII 一律会做百分号编码，所以这里排除是安全的。
 */
const URL_STOP = '\\s"\'<>，。、；：！？（）【】「」《》'
const CJK = '\\u2e80-\\u9fff\\u3000-\\u303f\\uff00-\\uffef'

const URL_PATTERN = new RegExp(`https?://[^${URL_STOP}${CJK}]+`, 'i')

/** 没有协议头的裸域名，同样常见于分享文案（"item.jd.com/xxx.html"） */
const BARE_DOMAIN_PATTERN = new RegExp(
  `\\b((?:[a-z0-9-]+\\.)+(?:com|cn|net|org|hk|co)(?:/[^${URL_STOP}${CJK}]*)?)`,
  'i',
)

/** 淘口令这类以符号包裹的分享码：￥xxxx￥、₤xxxx₤、(xxxx) 等 */
const SHARE_CODE_PATTERN = /[￥¥₤€《（(][A-Za-z0-9]{6,}[￥¥₤€》》）)]/

export interface TextExtraction {
  url: string | null
  /** 文案里是否有无法自动解析的分享码（淘口令等），用于提示用户改用截图 */
  hasShareCode: boolean
}

/**
 * 从一段分享文案里抽出商品链接。
 *
 * 用户从 App 分享出来的原文通常长这样：
 *   【淘宝】https://m.tb.cn/h.abc123 CZ3457 「某件衣服」点击链接直接打开
 * 直接把这个字符串当 URL 用必然失败，所以必须先抽。
 */
export function extractUrlFromText(text: string): TextExtraction {
  const trimmed = text.trim()
  const hasShareCode = SHARE_CODE_PATTERN.test(trimmed)

  const withScheme = trimmed.match(URL_PATTERN)
  if (withScheme) {
    return { url: stripTrailingPunctuation(withScheme[0]), hasShareCode }
  }

  const bare = trimmed.match(BARE_DOMAIN_PATTERN)
  if (bare?.[1]) {
    return { url: `https://${stripTrailingPunctuation(bare[1])}`, hasShareCode }
  }

  return { url: null, hasShareCode }
}

/** 分享文案里的链接常被中文标点紧跟，这些字符不属于 URL */
function stripTrailingPunctuation(url: string): string {
  return url.replace(/[，。、；：！？）)】」》"'.,;:!?]+$/, '')
}
