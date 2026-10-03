import { describe, expect, it } from 'vitest'

import { hostnameOf, matchPlatform } from './platforms'

describe('matchPlatform', () => {
  it.each([
    ['item.taobao.com', 'taobao'],
    ['detail.tmall.com', 'tmall'],
    ['item.jd.com', 'jd'],
    ['item.m.jd.com', 'jd'],
    ['mobile.yangkeduo.com', 'pdd'],
    ['www.xiaohongshu.com', 'xiaohongshu'],
    ['haohuo.jinritemai.com', 'douyin'],
    ['www.dewu.com', 'dewu'],
  ])('识别 %s 为 %s', (host, expected) => {
    expect(matchPlatform(host).platform).toBe(expected)
  })

  it('主站域名本身也算命中', () => {
    expect(matchPlatform('taobao.com').platform).toBe('taobao')
    expect(matchPlatform('jd.com').platform).toBe('jd')
  })

  it('未知域名归为 other', () => {
    expect(matchPlatform('shop.example.com').platform).toBe('other')
    expect(matchPlatform('amazon.com').platform).toBe('other')
  })

  describe('后缀匹配的安全边界', () => {
    it('不把 evl-taobao.com 当成淘宝', () => {
      // 朴素地 includes('taobao.com') 会在这里误判，
      // 于是攻击者注册一个形似的域名就能让我们的"淘宝专用解析器"跑起来
      expect(matchPlatform('evl-taobao.com').platform).toBe('other')
      expect(matchPlatform('nottaobao.com').platform).toBe('other')
      expect(matchPlatform('taobao.com.evil.net').platform).toBe('other')
    })

    it('子域正常命中', () => {
      expect(matchPlatform('a.b.taobao.com').platform).toBe('taobao')
    })
  })

  describe('短链识别', () => {
    it.each([
      ['m.tb.cn', 'taobao'],
      ['u.jd.com', 'jd'],
      ['3.cn', 'jd'],
      ['xhslink.com', 'xiaohongshu'],
      ['v.douyin.com', 'douyin'],
    ])('%s 识别为短链（%s）', (host, expected) => {
      const match = matchPlatform(host)

      expect(match.isShortLink).toBe(true)
      expect(match.platform).toBe(expected)
    })

    it('普通商品页不算短链', () => {
      expect(matchPlatform('item.jd.com').isShortLink).toBe(false)
    })
  })

  it('大小写不敏感', () => {
    expect(matchPlatform('ITEM.TAOBAO.COM').platform).toBe('taobao')
  })
})

describe('hostnameOf', () => {
  it('取主机名', () => {
    expect(hostnameOf('https://item.jd.com/100.html')).toBe('item.jd.com')
  })

  it('非法地址返回 null 而不是抛错', () => {
    // 解析链路上不该有异常，一个坏字符串不能让整条链路 500
    expect(hostnameOf('不是地址')).toBeNull()
    expect(hostnameOf('')).toBeNull()
  })
})
