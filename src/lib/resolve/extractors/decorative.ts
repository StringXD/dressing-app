/**
 * 判断一张图是不是"页面装饰"而非商品图。
 *
 * 为什么必须做这件事：实测拼多多的商品页即使商品不存在，也会返回一个
 * `og:image` —— 内容却是 `base/share_logo.jpg`（站点通用分享 logo）。
 * 不作过滤的话，我们会把一个假链接的兜底 logo 当成商品图交给用户去确认，
 * 比"明确说解析失败"糟糕得多：用户会以为自己选对了。
 *
 * 这里刻意用**保守的标记匹配**而不是去猜图片内容：
 * 漏掉一张真图只是少一个候选（用户还能自己发截图），
 * 而放进一张假图会让用户做出错误判断。
 */
const DECORATIVE_MARKERS: readonly string[] = [
  'logo',
  'icon',
  'favicon',
  'sprite',
  'avatar',
  'qrcode',
  'qr-code',
  'qr_code',
  'placeholder',
  'loading',
  'spinner',
  'share_logo',
  'share-logo',
  'sharelogo',
  'share_img',
  'share_img_',
  'default_img',
  'default-image',
  'blank.',
  'transparent.',
  'pixel.',
  'banner-',
  'banner_',
  '/ads/',
  'advert',
  'wechat',
  'weixin',
  'footer',
  'header-',
  'header_',
]

/**
 * @param url  图片地址
 * @param label 图片的 alt / 用途说明（可能为空）
 */
export function isDecorativeImage(url: string, label = ''): boolean {
  const haystack = `${url} ${label}`.toLowerCase()

  if (DECORATIVE_MARKERS.some((marker) => haystack.includes(marker))) return true

  // 1×1 / 2×2 的追踪像素
  if (/[?&](w|width)=[12]\b/.test(haystack)) return true

  return false
}
