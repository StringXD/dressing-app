import { hasEnv, requireEnv } from '@/lib/env'

import { isDecorativeImage } from './decorative'
import type { ExtractContext, ExtractResult, Extractor, ResolveCandidate } from '../types'

/**
 * Jina Reader 与 Firecrawl 形状相同：把一个 URL 交给第三方代理，
 * 由它渲染 JS 后回传正文（markdown），我们再从正文里抽图片链接。
 *
 * 因为形状相同就放在同一个文件里 —— 拆成三个文件只会让"改一处要改三处"
 * 的耦合看起来像解耦。
 */

const PROXY_TIMEOUT_MS = 40_000

/**
 * 从 markdown 里抽图片链接。
 *
 * 用 markdown 而不是 HTML 是因为这两个服务的正文形态就是 markdown；
 * 再解析 HTML 等于多绕一圈。
 *
 * 关键点：渲染后的正文里混着大量**站点装饰图**（logo、图标、二维码）。
 * 不清理的话，候选列表会被垃圾图淹没，用户根本挑不出商品图。
 */
export function extractImagesFromMarkdown(markdown: string, base: string): ResolveCandidate[] {
  const out: ResolveCandidate[] = []
  const seen = new Set<string>()

  // ![alt](url "title") 与 [![alt](url)](link) 两种嵌法都能命中前者
  const pattern = /!\[([^\]]{0,60})\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g

  for (const match of markdown.matchAll(pattern)) {
    const rawUrl = match[2]
    const alt = match[1]?.trim() ?? ''

    if (!rawUrl) continue

    let resolved: string
    try {
      const url = new URL(rawUrl, base)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
      resolved = url.toString()
    } catch {
      continue
    }

    if (seen.has(resolved)) continue
    if (isDecorativeImage(resolved, alt)) continue

    seen.add(resolved)
    out.push({ imageUrl: resolved, label: alt || undefined })
  }

  return out
}

interface ReaderConfig {
  name: string
  availability: () => { available: true } | { available: false; reason: string }
  fetchMarkdown: (url: string, signal: AbortSignal) => Promise<Response>
  /** 有些服务在正文之外还会单独给主图与标题 */
  readExtras?: (payload: unknown) => { title?: string; images?: string[] }
}

/** 两个 reader 档位共用的实现 */
function createReaderExtractor(tier: 'jina' | 'firecrawl', config: ReaderConfig): Extractor {
  return {
    tier,

    availability: config.availability,

    async extract(ctx: ExtractContext): Promise<ExtractResult> {
      const timeout = AbortSignal.timeout(PROXY_TIMEOUT_MS)
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout

      let response: Response
      try {
        response = await config.fetchMarkdown(ctx.finalUrl, signal)
      } catch (error) {
        return {
          ok: false,
          reason: `${config.name} 请求失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }

      if (!response.ok) {
        return { ok: false, reason: `${config.name} 返回 HTTP ${response.status}` }
      }

      let body: string
      try {
        body = await response.text()
      } catch (error) {
        return {
          ok: false,
          reason: `${config.name} 响应读取失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }

      // Jina 直接回 markdown 文本；Firecrawl 回 JSON。统一成 markdown + extras 两种输入。
      let markdown = body
      let title: string | undefined
      const candidates: ResolveCandidate[] = []

      if (config.readExtras) {
        try {
          const payload: unknown = JSON.parse(body)
          const extras = config.readExtras(payload)
          title = extras.title
          for (const url of extras.images ?? []) {
            candidates.push({ imageUrl: url, label: config.name })
          }

          const data = (payload as { data?: { markdown?: string } }).data
          markdown = data?.markdown ?? ''
        } catch {
          return { ok: false, reason: `${config.name} 返回的不是预期 JSON` }
        }
      }

      candidates.push(...extractImagesFromMarkdown(markdown, ctx.finalUrl))

      if (candidates.length === 0) {
        return {
          ok: false,
          reason: `${config.name} 渲染后的正文里没有图片链接（页面可能需要登录，或图片由 JS 动态加载）`,
        }
      }

      return { ok: true, candidates, title }
    },
  }
}

/**
 * Tier B：Jina Reader。
 *
 * 会渲染 JS，因此能拿到 SPA 的正文。**但实测在本开发环境不可达**
 * （r.jina.ai 返回 0 字节，两次探测一致）—— 这可能是网络环境所致。
 * 保留它是因为：availability() 可无 Key 启用，若部署环境可达就能白捡一档；
 * 不可达时它会以"请求失败"进入 attempts，链路的其余部分不受影响。
 */
export function createJinaExtractor(): Extractor {
  return createReaderExtractor('jina', {
    name: 'Jina Reader',
    availability: () => ({ available: true }),
    fetchMarkdown: (url, signal) => {
      const headers: Record<string, string> = { accept: 'text/plain' }

      // 无 Key 也能用（有速率限制）；配了 Key 就带上以提升配额。
      // 这里读 process.env 而不是 env：JINA_API_KEY 是可选增强，
      // 缺席时不该让 env.ts 的启动校验失败。
      const jinaKey = process.env.JINA_API_KEY?.trim()
      if (jinaKey) {
        headers.authorization = `Bearer ${jinaKey}`
      }

      return fetch(`https://r.jina.ai/${url}`, { signal, headers })
    },
  })
}

/**
 * Tier B：Firecrawl。
 *
 * 要 Key，因此 availability() 在未配置时返回不可用 —— 整档安静跳过。
 * 比 Jina 贵，但更稳定，且返回结构化的 ogImage/title。
 */
export function createFirecrawlExtractor(): Extractor {
  return createReaderExtractor('firecrawl', {
    name: 'Firecrawl',
    availability: () =>
      hasEnv('FIRECRAWL_API_KEY')
        ? { available: true }
        : { available: false, reason: '未配置 FIRECRAWL_API_KEY' },
    fetchMarkdown: (url, signal) =>
      fetch('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${requireEnv('FIRECRAWL_API_KEY')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      }),
    readExtras: (payload) => {
      const data = (payload as { data?: { metadata?: Record<string, unknown> } }).data
      const metadata = data?.metadata

      const ogImage = metadata?.ogImage
      const title = metadata?.title

      return {
        title: typeof title === 'string' ? title : undefined,
        images:
          typeof ogImage === 'string' && ogImage.startsWith('http') ? [ogImage] : undefined,
      }
    },
  })
}
