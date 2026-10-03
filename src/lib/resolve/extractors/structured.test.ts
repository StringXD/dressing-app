import { describe, expect, it } from 'vitest'

import { createStructuredExtractor, extractFromJsonLd } from './structured'
import type { ExtractContext } from '../types'

const BASE = 'https://shop.example.com/products/feng-yi'

function ctx(url = BASE): ExtractContext {
  return { finalUrl: url, platform: 'other' }
}

function fakeFetch(html: string, init?: { status?: number; contentType?: string }): typeof fetch {
  return (async () =>
    new Response(html, {
      status: init?.status ?? 200,
      headers: { 'content-type': init?.contentType ?? 'text/html' },
    })) as typeof fetch
}

function extractorFor(html: string, init?: { status?: number }) {
  return createStructuredExtractor({ fetchImpl: fakeFetch(html, init) })
}

describe('og:image', () => {
  it('取出主图', async () => {
    const result = await extractorFor(
      '<meta property="og:image" content="https://cdn.example.com/a.jpg">',
    ).extract(ctx())

    expect(result.ok).toBe(true)
    expect(result.ok && result.candidates[0].imageUrl).toBe('https://cdn.example.com/a.jpg')
  })

  it('优先使用 secure_url', async () => {
    const html = `
      <meta property="og:image" content="http://cdn.example.com/insecure.jpg">
      <meta property="og:image:secure_url" content="https://cdn.example.com/secure.jpg">
    `
    const result = await extractorFor(html).extract(ctx())

    expect(result.ok && result.candidates[0].imageUrl).toBe('https://cdn.example.com/secure.jpg')
  })

  it('content 写在 property 之前也能认', async () => {
    const html = '<meta content="https://cdn.example.com/a.jpg" property="og:image">'
    const result = await extractorFor(html).extract(ctx())

    expect(result.ok && result.candidates[0].imageUrl).toBe('https://cdn.example.com/a.jpg')
  })

  it('回退到 twitter:image', async () => {
    const html = '<meta name="twitter:image" content="https://cdn.example.com/t.jpg">'
    const result = await extractorFor(html).extract(ctx())

    expect(result.ok && result.candidates[0].imageUrl).toBe('https://cdn.example.com/t.jpg')
  })

  it('解码 &amp; 这类实体', async () => {
    const html = '<meta property="og:image" content="https://cdn.example.com/a.jpg?x=1&amp;y=2">'
    const result = await extractorFor(html).extract(ctx())

    expect(result.ok && result.candidates[0].imageUrl).toBe('https://cdn.example.com/a.jpg?x=1&y=2')
  })

  it('相对路径按页面地址解析', async () => {
    const result = await extractorFor('<meta property="og:image" content="/img/a.jpg">').extract(ctx())

    expect(result.ok && result.candidates[0].imageUrl).toBe('https://shop.example.com/img/a.jpg')
  })

  it('拒绝 data: 这类非 http 协议', async () => {
    // data: 与 javascript: 不能被当成商品图去抓
    const result = await extractorFor(
      '<meta property="og:image" content="data:image/png;base64,AAAA">',
    ).extract(ctx())

    expect(result.ok).toBe(false)
  })
})

describe('JSON-LD', () => {
  it('顶层对象的 image 字符串', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Product',
      name: '风衣',
      image: 'https://cdn.example.com/j.jpg',
    })}</script>`

    const result = extractFromJsonLd(html, BASE)

    expect(result.candidates.map((c) => c.imageUrl)).toEqual(['https://cdn.example.com/j.jpg'])
    expect(result.title).toBe('风衣')
  })

  it('顶层是数组', () => {
    const html = `<script type="application/ld+json">${JSON.stringify([
      { '@type': 'Product', image: 'https://cdn.example.com/1.jpg' },
      { '@type': 'Product', image: 'https://cdn.example.com/2.jpg' },
    ])}</script>`

    expect(extractFromJsonLd(html, BASE).candidates.map((c) => c.imageUrl)).toEqual([
      'https://cdn.example.com/1.jpg',
      'https://cdn.example.com/2.jpg',
    ])
  })

  it('@graph 嵌套', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite' },
        { '@type': 'Product', name: '大衣', image: ['https://cdn.example.com/g.jpg'] },
      ],
    })}</script>`

    const result = extractFromJsonLd(html, BASE)

    expect(result.candidates.map((c) => c.imageUrl)).toEqual(['https://cdn.example.com/g.jpg'])
    expect(result.title).toBe('大衣')
  })

  it('image 是对象数组（ImageObject）', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'Product',
      image: [{ url: 'https://cdn.example.com/o.jpg' }],
    })}</script>`

    expect(extractFromJsonLd(html, BASE).candidates[0].imageUrl).toBe(
      'https://cdn.example.com/o.jpg',
    )
  })

  it('语法错误的 JSON-LD 被跳过而不是抛错', () => {
    // 线上尾逗号、未转义引号很常见
    const html = '<script type="application/ld+json">{ "image": "https://x/a.jpg", }</script>'

    expect(() => extractFromJsonLd(html, BASE)).not.toThrow()
    expect(extractFromJsonLd(html, BASE).candidates).toHaveLength(0)
  })

  it('多个 ld+json 块都会读', () => {
    const html = `
      <script type="application/ld+json">{"@type":"Product","image":"https://x/1.jpg"}</script>
      <script type="application/ld+json">{"@type":"Product","image":"https://x/2.jpg"}</script>
    `

    expect(extractFromJsonLd(html, BASE).candidates).toHaveLength(2)
  })
})

describe('候选去重与排序', () => {
  it('同一张图出现多次只保留一次', async () => {
    const html = `
      <meta property="og:image" content="https://cdn.example.com/a.jpg">
      <script type="application/ld+json">{"image":"https://cdn.example.com/a.jpg"}</script>
    `
    const result = await extractorFor(html).extract(ctx())

    expect(result.ok && result.candidates).toHaveLength(1)
  })

  it('og:image 排在 JSON-LD 之前（前者更常是主图）', async () => {
    const html = `
      <script type="application/ld+json">{"image":"https://cdn.example.com/ld.jpg"}</script>
      <meta property="og:image" content="https://cdn.example.com/og.jpg">
    `
    const result = await extractorFor(html).extract(ctx())

    expect(result.ok && result.candidates.map((c) => c.label)).toEqual(['og:image', 'JSON-LD'])
  })
})

describe('标题提取', () => {
  // 注意：这些用例的 HTML 必须带一张图，否则提取器会因"没找到图"而整体失败，
  // 标题也就无从谈起 —— 标题只在成功返回时才附带。
  const WITH_IMAGE = '<meta property="og:image" content="https://cdn.example.com/a.jpg">'

  it('优先 og:title', async () => {
    const html = `<meta property="og:title" content="风衣"><title>站点名</title>${WITH_IMAGE}`
    const result = await extractorFor(html).extract(ctx())

    expect(result.ok && result.title).toBe('风衣')
  })

  it('回退到 title 标签', async () => {
    const html = `<title>某件风衣 - 示例商城</title>${WITH_IMAGE}`
    const result = await extractorFor(html).extract(ctx())

    expect(result.ok && result.title).toBe('某件风衣 - 示例商城')
  })

  it('回退到 JSON-LD 的 name', async () => {
    const html = `<script type="application/ld+json">{"name":"羽绒服","image":"https://cdn.example.com/b.jpg"}</script>`
    const result = await extractorFor(html).extract(ctx())

    expect(result.ok && result.title).toBe('羽绒服')
  })
})

describe('装饰图过滤', () => {
  it('过滤掉站点分享 logo（实测拼多多的真实行为）', async () => {
    // 实测：拼多多商品页即使 goods_id 不存在，也会返回
    // <meta property="og:image" content="https://funimg.pddpic.com/base/share_logo.jpg">
    // 把它当商品图交给用户确认，比直接说"解析失败"更糟 —— 用户会以为选对了。
    const html =
      '<meta property="og:image" content="https://funimg.pddpic.com/base/share_logo.jpg">'
    const result = await extractorFor(html).extract(ctx())

    expect(result.ok).toBe(false)
  })

  it('过滤 logo / icon / 占位图', async () => {
    const html = `
      <meta property="og:image" content="https://cdn.example.com/site-logo.png">
      <script type="application/ld+json">{"image":"https://cdn.example.com/placeholder.jpg"}</script>
    `
    const result = await extractorFor(html).extract(ctx())

    expect(result.ok).toBe(false)
  })

  it('真正的商品图不受影响', async () => {
    const html = '<meta property="og:image" content="https://cdn.example.com/goods/12345.jpg">'
    const result = await extractorFor(html).extract(ctx())

    expect(result.ok).toBe(true)
  })

  it('装饰图与商品图并存时只留下商品图', async () => {
    const html = `
      <meta property="og:image" content="https://cdn.example.com/logo.png">
      <script type="application/ld+json">{"image":"https://cdn.example.com/goods/9.jpg"}</script>
    `
    const result = await extractorFor(html).extract(ctx())

    expect(result.ok && result.candidates.map((c) => c.imageUrl)).toEqual([
      'https://cdn.example.com/goods/9.jpg',
    ])
  })
})

describe('失败路径', () => {
  it('页面里没有任何图时给出可读原因', async () => {
    const result = await extractorFor('<html><body>空页面</body></html>').extract(ctx())

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('未找到')
  })

  it('识别出"纯 JS 空壳"并单独措辞', async () => {
    // 实测京东商品页就是这种形态：HTML 里一张商品图都没有。
    // 这时的原因必须让人明白"该发截图"，而不是以为链接给错了。
    const shell = '<html><body><div id="app"></div><script src="/main.js"></script></body></html>'
    const result = await extractorFor(shell).extract(ctx())

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('纯 JS 渲染')
  })

  it('HTTP 错误返回失败而不是抛错', async () => {
    const result = await extractorFor('<html></html>', { status: 403 }).extract(ctx())

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('403')
  })

  it('网络异常返回失败而不是抛错', async () => {
    const extractor = createStructuredExtractor({
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED')
      }) as typeof fetch,
    })

    const result = await extractor.extract(ctx())

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain('抓取页面失败')
  })
})

describe('可用性', () => {
  it('无需任何 Key，永远可用', () => {
    expect(createStructuredExtractor().availability()).toEqual({ available: true })
  })

  it('档位标记为 structured', () => {
    expect(createStructuredExtractor().tier).toBe('structured')
  })
})
