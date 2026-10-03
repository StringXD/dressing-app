import { hasEnv, requireEnv } from '@/lib/env'

import type { ExtractContext, ExtractResult, Extractor, ResolveCandidate } from '../types'

const API_TIMEOUT_MS = 15_000

/**
 * 万邦（open.onebound.cn）的接口形态。
 *
 * ⚠️ **尚未用真实 Key 验证过**：万邦需注册询价，本项目还没拿到 Key。
 * 下面的路径与字段名来自其公开文档，若首次接入时对不上，
 * 先看 `describeShape()` 打印出的实际结构，改这一处即可。
 *
 * 之所以先写下来而不是等 Key：契约先落地，接线时才只改这一处；
 * 而且 availability() 会在缺 Key 时让整档安静跳过，
 * 所以这段代码在拿到 Key 之前不会影响任何真实链路的行为。
 */
const API_BASE = 'https://api-gw.onebound.cn'

/** 从商品页地址里取平台要求的商品 id */
export function extractItemId(platform: string, url: string): string | null {
  try {
    const parsed = new URL(url)

    // 淘宝/天猫：item.htm?id=123456 或 detail.tmall.com/item.htm?id=...
    const queryId = parsed.searchParams.get('id') ?? parsed.searchParams.get('item_id')
    if (queryId && /^\d+$/.test(queryId)) return queryId

    // 京东：item.jd.com/100012043978.html 或 item.m.jd.com/product/100012043978.html
    const pathMatch = parsed.pathname.match(/\/(?:product\/)?(\d{6,})\.html?$/)
    if (pathMatch?.[1]) return pathMatch[1]

    return null
  } catch {
    return null
  }
}

/** 万邦支持的平台名。目前核验覆盖 taobao/tmall/jd。 */
function apiPlatformOf(platform: string): string | null {
  switch (platform) {
    case 'taobao':
      return 'taobao'
    case 'tmall':
      return 'tmall'
    case 'jd':
      return 'jd'
    default:
      return null
  }
}

/**
 * 打印响应结构（只到两层、值只给类型）。
 *
 * 因为接口形态未验证，第一次接入时需要一个"它到底返回了什么"的抓手，
 * 而不是对着 `undefined` 猜。刻意不打印值本身，避免把商品数据写进日志。
 */
function describeShape(value: unknown, depth = 0): string {
  if (depth > 2) return '…'
  if (Array.isArray(value)) {
    return value.length > 0 ? `[${describeShape(value[0], depth + 1)} × ${value.length}]` : '[]'
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, 12)
      .map(([k, v]) => `${k}: ${describeShape(v, depth + 1)}`)
    return `{ ${entries.join(', ')} }`
  }
  return typeof value
}

/** 从万邦返回体里挖图片。字段名按文档写，同时兼容几种常见变体。 */
function readCandidates(item: Record<string, unknown>): ResolveCandidate[] {
  const out: ResolveCandidate[] = []

  const imgs = item.item_imgs ?? item.itemImg ?? item.images
  if (Array.isArray(imgs)) {
    for (const entry of imgs) {
      if (typeof entry === 'string') {
        out.push({ imageUrl: entry, label: '万邦' })
      } else if (typeof entry === 'object' && entry !== null) {
        const url = (entry as Record<string, unknown>).url
        if (typeof url === 'string') out.push({ imageUrl: url, label: '万邦' })
      }
    }
  }

  // 主图字段
  for (const key of ['pic_url', 'main_img', 'image_url']) {
    const value = item[key]
    if (typeof value === 'string' && value.startsWith('http')) {
      out.push({ imageUrl: value, label: '万邦主图' })
    }
  }

  return out
}

export function createOneboundExtractor(): Extractor {
  return {
    tier: 'onebound',

    availability: () => {
      if (!hasEnv('ONEBOUND_KEY') || !hasEnv('ONEBOUND_SECRET')) {
        return {
          available: false,
          reason: '未配置万邦 Key（需在 open.onebound.cn 注册询价）',
        }
      }
      return { available: true }
    },

    async extract(ctx: ExtractContext): Promise<ExtractResult> {
      const apiPlatform = apiPlatformOf(ctx.platform)

      if (!apiPlatform) {
        return { ok: false, reason: `万邦不覆盖 ${ctx.platform} 平台` }
      }

      const itemId = extractItemId(ctx.platform, ctx.finalUrl)
      if (!itemId) {
        return { ok: false, reason: `无法从地址中提取商品 id：${ctx.finalUrl}` }
      }

      // 这里才读 Key —— availability() 已经保证存在，但保持调用点自洽
      const key = requireEnv('ONEBOUND_KEY')
      const secret = requireEnv('ONEBOUND_SECRET')

      const endpoint = new URL(`${API_BASE}/${apiPlatform}/item_get/`)
      endpoint.searchParams.set('key', key)
      endpoint.searchParams.set('secret', secret)
      endpoint.searchParams.set('num_iid', itemId)
      endpoint.searchParams.set('lang', 'zh-CN')

      const timeout = AbortSignal.timeout(API_TIMEOUT_MS)
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout

      let payload: unknown
      try {
        const response = await fetch(endpoint, { signal })
        if (!response.ok) {
          return { ok: false, reason: `万邦返回 HTTP ${response.status}` }
        }
        payload = await response.json()
      } catch (error) {
        return {
          ok: false,
          reason: `调用万邦失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }

      if (typeof payload !== 'object' || payload === null) {
        return { ok: false, reason: '万邦返回的不是 JSON 对象' }
      }

      const root = payload as Record<string, unknown>

      // 万邦在业务层用 error_code/error 表达失败，HTTP 仍是 200
      if (root.error_code || root.error) {
        const message = String(root.reason ?? root.error ?? root.error_code)
        return { ok: false, reason: `万邦拒绝：${message}` }
      }

      const item = root.item
      if (typeof item !== 'object' || item === null) {
        return {
          ok: false,
          reason: `万邦返回体中没有 item 字段。实际结构：${describeShape(payload)}`,
        }
      }

      const candidates = readCandidates(item as Record<string, unknown>)
      if (candidates.length === 0) {
        return {
          ok: false,
          reason: `万邦返回的 item 中没有可识别的图片字段。实际结构：${describeShape(item)}`,
        }
      }

      const titleValue = (item as Record<string, unknown>).title

      return {
        ok: true,
        candidates,
        title: typeof titleValue === 'string' ? titleValue : undefined,
      }
    },
  }
}
