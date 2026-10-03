import { describe, expect, it } from 'vitest'

import { expandShortLink, extractHtmlRedirect, extractUrlFromText } from './shortlink'

/** 造一个只回指定响应的假 fetch，避免测试打真实网络 */
function fakeFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch
}

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } })
}

function htmlPage(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } })
}

describe('extractUrlFromText', () => {
  it('从淘宝分享文案里抽出链接', () => {
    const text =
      '【淘宝】https://m.tb.cn/h.abcdefg?tk=xyz123 CZ3457 「春季新款风衣」点击链接直接打开'

    expect(extractUrlFromText(text).url).toBe('https://m.tb.cn/h.abcdefg?tk=xyz123')
  })

  it('处理链接后面紧跟中文标点的情况', () => {
    expect(extractUrlFromText('看这个 https://item.jd.com/100.html，很好').url).toBe(
      'https://item.jd.com/100.html',
    )
  })

  it('没有协议头的裸域名也能认，并补上 https', () => {
    expect(extractUrlFromText('item.jd.com/100012043978.html').url).toBe(
      'https://item.jd.com/100012043978.html',
    )
  })

  it('识别淘口令这类分享码', () => {
    const result = extractUrlFromText('8￥CZ3457abcdef￥ 复制打开淘宝')

    expect(result.url).toBeNull()
    expect(result.hasShareCode).toBe(true)
  })

  it('纯文字里没有链接也没有分享码', () => {
    const result = extractUrlFromText('帮我换一件风衣')

    expect(result.url).toBeNull()
    expect(result.hasShareCode).toBe(false)
  })

  it('纯空白输入不抛错', () => {
    expect(extractUrlFromText('   ').url).toBeNull()
  })
})

describe('extractHtmlRedirect', () => {
  const base = 'https://m.tb.cn/h.abc'

  it('认 meta refresh', () => {
    const html = '<html><head><meta http-equiv="refresh" content="0;url=https://item.taobao.com/item.htm?id=1"></head></html>'

    expect(extractHtmlRedirect(html, base)).toBe('https://item.taobao.com/item.htm?id=1')
  })

  it('认 JS 跳转', () => {
    const html = "<script>window.location.href = 'https://item.jd.com/100.html'</script>"

    expect(extractHtmlRedirect(html, base)).toBe('https://item.jd.com/100.html')
  })

  it('认 location.replace', () => {
    const html = "<script>location.replace('https://www.dewu.com/x')</script>"

    expect(extractHtmlRedirect(html, base)).toBe('https://www.dewu.com/x')
  })

  it('相对路径按当前地址解析', () => {
    const html = '<meta http-equiv="refresh" content="0;url=/item/100.html">'

    expect(extractHtmlRedirect(html, base)).toBe('https://m.tb.cn/item/100.html')
  })

  it('没有跳转时返回 null', () => {
    expect(extractHtmlRedirect('<html><body>正常页面</body></html>', base)).toBeNull()
  })
})

describe('expandShortLink', () => {
  it('跟随 3xx 的 Location 直到终点', async () => {
    const seen: string[] = []
    const fetchImpl = fakeFetch((url) => {
      seen.push(url)
      if (url === 'https://m.tb.cn/h.abc') return redirectTo('https://item.taobao.com/item.htm?id=1')
      return htmlPage('<html><body>商品页</body></html>')
    })

    const result = await expandShortLink('https://m.tb.cn/h.abc', { fetchImpl })

    expect(result.finalUrl).toBe('https://item.taobao.com/item.htm?id=1')
    expect(result.complete).toBe(true)
    expect(result.hops).toBe(1)
    expect(seen).toHaveLength(2)
  })

  it('跟随 200 + meta refresh（国内短链常见形态）', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === 'https://m.tb.cn/h.abc') {
        return htmlPage('<meta http-equiv="refresh" content="0;url=https://item.taobao.com/item.htm?id=9">')
      }
      return htmlPage('<body>好</body>')
    })

    const result = await expandShortLink('https://m.tb.cn/h.abc', { fetchImpl })

    expect(result.finalUrl).toBe('https://item.taobao.com/item.htm?id=9')
    expect(result.complete).toBe(true)
    expect(result.hops).toBe(1)
  })

  it('多跳链路能一路跟到底', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url === 'https://m.tb.cn/h.abc') return redirectTo('https://3.cn/xyz')
      if (url === 'https://3.cn/xyz') return redirectTo('https://item.jd.com/100.html')
      return htmlPage('<body>京东商品页</body>')
    })

    const result = await expandShortLink('https://m.tb.cn/h.abc', { fetchImpl })

    expect(result.finalUrl).toBe('https://item.jd.com/100.html')
    expect(result.hops).toBe(2)
    expect(result.complete).toBe(true)
  })

  it('网络错误不抛异常，返回已到达的地址', async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error('socket hang up')
    })

    const result = await expandShortLink('https://m.tb.cn/h.abc', { fetchImpl })

    expect(result.finalUrl).toBe('https://m.tb.cn/h.abc')
    expect(result.complete).toBe(false)
    expect(result.detail).toContain('请求失败')
  })

  describe('安全边界：不跟随内网地址', () => {
    it.each([
      'http://127.0.0.1/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/internal',
      'http://192.168.1.1/',
      'http://localhost:5432',
      'http://db/query',
    ])('拒绝 %s', async (target) => {
      // 攻击场景：用户发一个指向内网的短链，让我们的服务端替他去请求
      const fetchImpl = fakeFetch((url) => {
        if (url === 'https://m.tb.cn/h.abc') return redirectTo(target)
        throw new Error('不该走到这里')
      })

      const result = await expandShortLink('https://m.tb.cn/h.abc', { fetchImpl })

      expect(result.complete).toBe(false)
      expect(result.detail).toContain('内网地址')
    })

    it('正常公网地址不受影响', async () => {
      const fetchImpl = fakeFetch(() => htmlPage('<body>好</body>'))

      const result = await expandShortLink('https://item.jd.com/100.html', { fetchImpl })

      expect(result.complete).toBe(true)
    })
  })

  it('跳转指向自身时停止，不会死循环', async () => {
    const fetchImpl = fakeFetch((url) => redirectTo(url))

    const result = await expandShortLink('https://m.tb.cn/h.abc', { fetchImpl })

    expect(result.complete).toBe(false)
    expect(result.hops).toBe(0)
  })

  it('超过跳数上限后停止', async () => {
    let counter = 0
    const fetchImpl = fakeFetch(() => {
      counter += 1
      return redirectTo(`https://m.tb.cn/hop${counter}`)
    })

    const result = await expandShortLink('https://m.tb.cn/h.abc', { fetchImpl })

    expect(result.complete).toBe(false)
    expect(result.hops).toBe(5)
    expect(result.detail).toContain('仍未到终点')
  })

  it('非 HTML 响应不被当成页面解析', async () => {
    const fetchImpl = fakeFetch(
      () => new Response('PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    )

    const result = await expandShortLink('https://m.tb.cn/h.abc', { fetchImpl })

    expect(result.complete).toBe(false)
    expect(result.detail).toContain('非 HTML')
  })
})
