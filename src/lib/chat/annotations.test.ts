import { describe, expect, it } from 'vitest'

import {
  ATTACHMENT_PREFIX,
  formatAttachmentLine,
  formatGarmentSelectionLine,
  parseAttachmentLines,
  stripAnnotationLines,
} from './annotations'

const PERSON = '11111111-2222-3333-4444-555555555555'
const GARMENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('附件标注', () => {
  it('写进去再读出来是同一件事 —— 这条往返是模型找到图的唯一途径', () => {
    // 编解码对不上时界面完全不报错，只是 Agent 一直说"没看到图片"。
    // 所以必须把往返本身钉住，而不是分别测两端。
    const line = formatAttachmentLine({ assetId: PERSON, kind: 'person' })

    expect(parseAttachmentLines(line)).toEqual([{ assetId: PERSON, kind: 'person' }])
  })

  it('人物照与服装图能区分开', () => {
    const text = [
      formatAttachmentLine({ assetId: PERSON, kind: 'person' }),
      formatAttachmentLine({ assetId: GARMENT, kind: 'garment' }),
    ].join('\n')

    expect(parseAttachmentLines(text)).toEqual([
      { assetId: PERSON, kind: 'person' },
      { assetId: GARMENT, kind: 'garment' },
    ])
  })

  it('剥掉标注行，只留用户真正打的字', () => {
    const text = ['帮我试试这件', formatAttachmentLine({ assetId: GARMENT, kind: 'garment' })].join(
      '\n',
    )

    // 标注不能让用户看见 —— 它是给模型看的机器可读行
    expect(stripAnnotationLines(text)).toBe('帮我试试这件')
  })

  it('用户自己打出 [附件] 开头的话时，不会产生假的 assetId', () => {
    // 用户是可以随便打字的。谎报一个不存在的 assetId 会让模型去查一张
    // 不属于任何人的图 —— 归属校验会拦住它，但那时对话已经白跑了一轮。
    expect(parseAttachmentLines(`${ATTACHMENT_PREFIX} 人物照 assetId=我说的是随便一串`)).toEqual([])
  })

  it('只认 UUID 形状，不认任意字符串', () => {
    expect(parseAttachmentLines(`${ATTACHMENT_PREFIX} 服装图 assetId=../../etc/passwd`)).toEqual([])
    expect(parseAttachmentLines(`${ATTACHMENT_PREFIX} 服装图 assetId=short-id`)).toEqual([])
  })
})

describe('工作台选中的服装', () => {
  it('写成一行带 garmentId 的标注 —— 模型照抄的就是 batchTryOn 要的那个 id', () => {
    expect(formatGarmentSelectionLine(GARMENT)).toBe(`[选择] 服装 garmentId=${GARMENT}`)
  })

  it('渲染时同样被剥掉，用户不该在自己的气泡里看见机器可读行', () => {
    const text = ['这几件都试试', formatGarmentSelectionLine(GARMENT)].join('\n')

    expect(stripAnnotationLines(text)).toBe('这几件都试试')
  })

  it('不会被当成附件解析出来 —— 两种 id 不能混', () => {
    /*
     * `[附件]` 行带 assetId，`[选择]` 行带 garmentId。一旦后者被当附件收下，
     * 界面就会拿一个服装 id 去找图片，模型也会收到一个并不存在的 assetId ——
     * 两边都不报错，只是"什么都没发生"。
     *
     * 老实说这条断言的**变异抵抗很弱**：前缀不同、字面量也不同（garmentId= 而非
     * assetId=），两道各自独立的门都会挡住它，所以常见重构下它照样是绿的。
     * 留着是因为它把这条不变量写下来了，但别把它当成主要防线 ——
     * 真正在防这件事的是两个常量本身。
     */
    expect(parseAttachmentLines(formatGarmentSelectionLine(GARMENT))).toEqual([])
  })
})