import { isDecorativeImage } from './decorative'
import type { ExtractContext, ExtractResult, Extractor, ResolveCandidate } from '../types'

const PAGE_TIMEOUT_MS = 12_000

/** 只读这么多 HTML。商品页几百 KB，而我们需要的信息全在 <head> 附近。 */
const MAX_HTML_BYTES = 512 * 1024

/** HTML 实体里 URL 上会出现的只有 &amp; 与 &#39; 这类，按需解码即可 */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function absolutize(url: string, base: string): string | null {
  try {
    const resolved = new URL(url, base)
    // 只接受 http(s)：data: 与 javascript: 不能作为商品图
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null
    return resolved.toString()
  } catch {
    return null
  }
}

/** 收集 <meta property|name="..." content="..."> 的值 */
function readMeta(html: string, keys: readonly string[]): string | null {
  for (const key of keys) {
    // property 与 name 两种写法都要认（og 规范用 property，但实现常混用）
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${key}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
      'i',
    )
    const match = html.match(pattern)
    if (match?.[1]?.trim()) return decodeEntities(match[1].trim())

    // content 写在 property 之前也是合法的
    const reversed = new RegExp(
      `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${key}["']`,
      'i',
    )
    const alt = html.match(reversed)
    if (alt?.[1]?.trim()) return decodeEntities(alt[1].trim())
  }

  return null
}

/**
 * 从 JSON-LD 里挖出商品图。
 *
 * 结构比 meta 复杂得多，实际见到过的形态：
 *   · 顶层就是对象 / 顶层是数组 / 对象里有 @graph 数组
 *   · image 是字符串 / 字符串数组 / { url: "..." } / [{ url: "..." }]
 * 这些都得认，否则会漏掉一大半电商站（Shopify、独立站普遍用 JSON-LD）。
 */
export function extractFromJsonLd(html: string, base: string): { candidates: ResolveCandidate[]; title: string | null } {
  const candidates: ResolveCandidate[] = []
  let title: string | null = null

  const scriptPattern =
    /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi

  for (const match of html.matchAll(scriptPattern)) {
    const raw = match[1]?.trim()
    if (!raw) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      // 线上 JSON-LD 语法错误很常见（尾逗号、未转义引号），跳过即可
      continue
    }

    for (const node of flattenJsonLd(parsed)) {
      const images = readImageField(node.image, base)
      for (const url of images) {
        candidates.push({ imageUrl: url, label: 'JSON-LD' })
      }

      if (!title && typeof node.name === 'string' && node.name.trim()) {
        title = node.name.trim()
      }
    }
  }

  return { candidates, title }
}

/** 把 JSON-LD 的三种常见嵌套形态拉平成一维节点列表 */
function flattenJsonLd(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap(flattenJsonLd)
  }

  if (typeof value !== 'object' || value === null) {
    return []
  }

  const node = value as Record<string, unknown>
  const graph = node['@graph']

  if (Array.isArray(graph)) {
    // @graph 里的节点也可能再带 image，节点自身也保留
    return [node, ...graph.flatMap(flattenJsonLd)]
  }

  return [node]
}

function readImageField(value: unknown, base: string): string[] {
  if (typeof value === 'string') {
    const url = absolutize(decodeEntities(value), base)
    return url ? [url] : []
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => readImageField(item, base))
  }

  if (typeof value === 'object' && value !== null) {
    // { url: "..." } 或 ImageObject
    const obj = value as Record<string, unknown>
    if (typeof obj.url === 'string') {
      const url = absolutize(decodeEntities(obj.url), base)
      return url ? [url] : []
    }
    if (typeof obj.contentUrl === 'string') {
      const url = absolutize(decodeEntities(obj.contentUrl), base)
      return url ? [url] : []
    }
  }

  return []
}

function readTitleTag(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)
  return match?.[1]?.trim() ? decodeEntities(match[1].trim()) : null
}

/** 去掉重复 URL，保留首次出现的顺序（og 通常最准，理应排在前面） */
function dedupe(candidates: ResolveCandidate[]): ResolveCandidate[] {
  const seen = new Set<string>()
  const out: ResolveCandidate[] = []

  for (const candidate of candidates) {
    if (seen.has(candidate.imageUrl)) continue
    seen.add(candidate.imageUrl)
    out.push(candidate)
  }

  return out
}

/**
 * 判断页面是不是"空壳"—— HTML 里根本没有内容，全靠 JS 渲染。
 *
 * 这个判断只影响错误措辞，但值得做：用户在对话里会看到这句话。
 * "页面为 JS 渲染，HTML 中无商品图"能让人立刻明白该发截图；
 * 而"未找到商品图"会让人以为是链接给错了。
 */
function looksLikeJsShell(html: string): boolean {
  if (html.length > 60_000) return false

  const hasAppRoot = /<div[^>]+id\s*=\s*["'](app|root|__next|__nuxt)["']/i.test(html)
  const imageCount = (html.match(/<img[\s>]/gi) ?? []).length

  return hasAppRoot && imageCount <= 2
}

export interface StructuredExtractorOptions {
  fetchImpl?: typeof fetch
}

/**
 * Tier B：通用结构化提取。
 *
 * 免费、无需 Key，对**服务端渲染**的站点最准（og:image 与 JSON-LD 都是标准）。
 * 对国内主流电商基本无效 —— 实测京东商品页 254KB 里一张商品图都没有，
 * 图片全部由 JS 加载；淘宝商品页则直接是登录墙。
 * 它的价值在于覆盖国际品牌站、Shopify、Amazon 这类站点。
 */
export function createStructuredExtractor(
  options: StructuredExtractorOptions = {},
): Extractor {
  const doFetch = options.fetchImpl ?? fetch

  return {
    tier: 'structured',

    availability: () => ({ available: true }),

    async extract(ctx: ExtractContext): Promise<ExtractResult> {
      const timeout = AbortSignal.timeout(PAGE_TIMEOUT_MS)
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout

      let response: Response
      try {
        response = await doFetch(ctx.finalUrl, {
          signal,
          redirect: 'follow',
          headers: {
            'user-agent':
              'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            accept: 'text/html,application/xhtml+xml',
            'accept-language': 'zh-CN,zh;q=0.9',
          },
        })
      } catch (error) {
        return {
          ok: false,
          reason: `抓取页面失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }

      if (!response.ok) {
        return { ok: false, reason: `页面返回 HTTP ${response.status}` }
      }

      let html: string
      try {
        html = (await response.text()).slice(0, MAX_HTML_BYTES)
      } catch (error) {
        return {
          ok: false,
          reason: `读取页面失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }

      // 用响应最终的地址做解析基准：页面可能自己又跳转过
      const base = response.url || ctx.finalUrl

      const candidates: ResolveCandidate[] = []

      const ogImage = readMeta(html, [
        'og:image:secure_url',
        'og:image:url',
        'og:image',
        'twitter:image',
        'twitter:image:src',
        'image',
      ])
      const ogUrl = ogImage ? absolutize(ogImage, base) : null
      if (ogUrl) candidates.push({ imageUrl: ogUrl, label: 'og:image' })

      const jsonLd = extractFromJsonLd(html, base)
      candidates.push(...jsonLd.candidates)

      const linkImage = html.match(
        /<link[^>]+rel\s*=\s*["']image_src["'][^>]*href\s*=\s*["']([^"']+)["']/i,
      )
      const linkUrl = linkImage?.[1] ? absolutize(decodeEntities(linkImage[1]), base) : null
      if (linkUrl) candidates.push({ imageUrl: linkUrl, label: 'image_src' })

      const title =
        readMeta(html, ['og:title', 'twitter:title']) ?? jsonLd.title ?? readTitleTag(html)

      // 过滤站点装饰图。实测拼多多的商品页即使商品不存在也会回一个
      // share_logo.jpg，把那种图当商品图交给用户确认，比直接说"解析失败"更糟。
      const unique = dedupe(
        candidates.filter((candidate) => !isDecorativeImage(candidate.imageUrl, candidate.label)),
      )

      if (unique.length === 0) {
        return {
          ok: false,
          reason: looksLikeJsShell(html)
            ? '页面为纯 JS 渲染，HTML 中不含商品图'
            : '页面 HTML 中未找到任何商品图（og:image / JSON-LD 均缺失）',
        }
      }

      return { ok: true, candidates: unique, title: title ?? undefined, finalUrl: base }
    },
  }
}
