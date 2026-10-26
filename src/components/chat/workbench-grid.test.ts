import { describe, expect, it } from 'vitest'

import { stripAnnotationLines } from '@/lib/chat/annotations'
import { formatWorkbenchSelection } from './workbench-grid'

/**
 * 守的是工作台提交时**编出来的那条文本**。
 *
 * 它是这次点击与花钱之间唯一的传递物：模型照着它调 `batchTryOn`，
 * 而它编错了不会有任何报错 —— 只会让模型说"找不到这件衣服"，
 * 或者更隐蔽地拿 assetId 去当 garmentId 用。所以这里盯的是
 * "哪个 id 写进了哪一行"，而不是文案。
 */

const PERSON = '11111111-2222-3333-4444-555555555555'
const PERSON_2 = '99999999-8888-7777-6666-555555555555'
const GARMENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const GARMENT_2 = 'cccccccc-dddd-eeee-ffff-000000000000'

describe('formatWorkbenchSelection', () => {
  it('人物照写成 [附件] 人物照 assetId=… —— 模型认这一种写法', () => {
    const text = formatWorkbenchSelection([PERSON], [])

    expect(text).toContain(`[附件] 人物照 assetId=${PERSON}`)
  })

  it('服装写成 [选择] 服装 garmentId=…，不是 assetId', () => {
    const text = formatWorkbenchSelection([], [GARMENT])

    expect(text).toContain(`[选择] 服装 garmentId=${GARMENT}`)
  })

  it('两种 id 绝不串行 —— 这是这一段最容易静默出错的地方', () => {
    const text = formatWorkbenchSelection([PERSON], [GARMENT])

    // 人物照不能出现在 garmentId 那一行（工具会说找不到这件衣服）
    expect(text).not.toContain(`garmentId=${PERSON}`)
    // 服装不能出现在 assetId 那一行（那会让模型去查一张不存在的图）
    expect(text).not.toContain(`assetId=${GARMENT}`)
  })

  it('多选时每一条都单独成行，不合并也不丢', () => {
    const text = formatWorkbenchSelection([PERSON, PERSON_2], [GARMENT, GARMENT_2])
    const lines = text.split('\n')

    expect(lines).toHaveLength(5) // 1 句指令 + 2 张人物照 + 2 件衣服
    expect(lines.filter((line) => line.includes('assetId='))).toHaveLength(2)
    expect(lines.filter((line) => line.includes('garmentId='))).toHaveLength(2)
  })

  it('用户在自己的气泡里只看见那句指令，看不见 id', () => {
    // 端到端地把两个模块接起来：编出来的文本必须能被渲染前的剥除逻辑吃掉。
    // 这条一旦失守，用户会看到满屏 UUID —— 不会坏，但没人愿意用
    const text = formatWorkbenchSelection([PERSON], [GARMENT])

    expect(stripAnnotationLines(text)).toBe('按工作台选好的素材批量试穿，请原样使用下面这些 id：')
  })

  it('什么都没选时只剩指令行，不会编出半条消息', () => {
    // 界面上按钮此时是禁用的，这里是防"按钮状态"和"文本内容"两处判断漂移
    expect(formatWorkbenchSelection([], []).split('\n')).toHaveLength(1)
  })
})
