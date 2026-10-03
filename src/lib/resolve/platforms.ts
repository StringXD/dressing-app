import { PLATFORMS, type Platform } from '@/lib/domain'

interface PlatformMatcher {
  platform: Platform
  /** 主站域名。**后缀匹配必须以点开头**，否则 evl-taobao.com 会被误判 */
  domains: readonly string[]
  /** 该平台的分享短链域名 —— 拿到这些要先展开才能识别真实商品页 */
  shortDomains: readonly string[]
}

/**
 * 平台 → 域名映射。
 *
 * 短链域名单独列出来，因为国内电商的分享几乎都走短链
 * （淘宝给 m.tb.cn，京东给 u.jd.com / 3.cn，小红书给 xhslink.com …）。
 * 不先把短链展开，平台识别会在第一步就失败 —— 这是整条链路最常见的断点。
 */
const MATCHERS: readonly PlatformMatcher[] = [
  {
    platform: 'taobao',
    domains: ['taobao.com', 'taobao.hk'],
    // m.tb.cn 是商品分享短链；tb.cn 下还有 s.tb.cn 等变体
    shortDomains: ['m.tb.cn', 'tb.cn'],
  },
  {
    platform: 'tmall',
    domains: ['tmall.com', 'tmall.hk'],
    shortDomains: ['m.tb.cn', 'tb.cn'],
  },
  {
    platform: 'jd',
    domains: ['jd.com', 'jd.hk', 'jingdong.com'],
    // 3.cn 是京东的极短链；u.jd.com 是分享短链
    shortDomains: ['u.jd.com', '3.cn'],
  },
  {
    platform: 'pdd',
    domains: ['yangkeduo.com', 'pinduoduo.com'],
    shortDomains: ['p.pinduoduo.com', 'yangkeduo.com'],
  },
  {
    platform: 'xiaohongshu',
    domains: ['xiaohongshu.com'],
    shortDomains: ['xhslink.com'],
  },
  {
    platform: 'douyin',
    domains: ['douyin.com', 'jinritemai.com', 'iesdouyin.com'],
    shortDomains: ['v.douyin.com'],
  },
  {
    platform: 'dewu',
    domains: ['dewu.com', 'poizon.com'],
    shortDomains: ['dw4.co', 'dewu.com'],
  },
] as const

/** 主机名是否属于某个域名（含其子域） */
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

export interface PlatformMatch {
  platform: Platform
  /** 是否是分享短链 —— 是的话必须先展开再谈解析 */
  isShortLink: boolean
}

/**
 * 按主机名识别平台。
 *
 * 短链域名可能同时属于多个平台（m.tb.cn 淘宝天猫共用），
 * 这时返回哪一个都不算错 —— 展开后会用真实域名再识别一次。
 */
export function matchPlatform(hostname: string): PlatformMatch {
  const host = hostname.toLowerCase()

  for (const matcher of MATCHERS) {
    if (matcher.shortDomains.some((d) => hostMatches(host, d))) {
      return { platform: matcher.platform, isShortLink: true }
    }
  }

  for (const matcher of MATCHERS) {
    if (matcher.domains.some((d) => hostMatches(host, d))) {
      return { platform: matcher.platform, isShortLink: false }
    }
  }

  return { platform: 'other', isShortLink: false }
}

/** 从 URL 里取主机名；非法 URL 返回 null 而不是抛错（解析链路上不该有异常） */
export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

export function isKnownPlatform(platform: Platform): boolean {
  return platform !== 'other'
}

export { PLATFORMS }
