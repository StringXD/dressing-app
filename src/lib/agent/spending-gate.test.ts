import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SPENDING_TOOL_APPROVAL } from '@/lib/agent/tools'

/**
 * 守的是**"新增一个花钱的工具，忘了登记进闸门"**。
 *
 * 工具文件头部写着"有单测守着新增花钱工具忘了登记就变红"，但在写这个文件之前
 * **并没有**这条测试 —— 只有一条反向的（分析工具不该进闸门）。注释描述了一个
 * 不存在的保证，比没有注释更糟：下一个人会以为这道防线在，于是不再自己查。
 *
 * ── 为什么断言落在源码上 ──────────────────────────────────────
 * "这个工具会不会花钱"在运行时是不可见的：`tool()` 返回的对象里没有成本字段，
 * 区别只在于它的 execute 里有没有调用 `enqueueGeneration`。要把这件事做成
 * 可断言的，有两条路：
 *
 *   1. 给工具定义加一个显式的 `spendsMoney: true` 标记 —— 但那个标记同样
 *      要靠人记得写，只是把"忘记登记"变成了"忘记标记"，没有变好。
 *   2. 直接看源码里每个工具块有没有调用入队函数。
 *
 * 选 2。它至少是**从代码事实推导出来的**，而不是把名单再抄一遍。
 *
 * ── 它不保证什么 ────────────────────────────────────────────
 * 它按缩进切块，所以工具定义必须保持 `    name: tool({` 这个形状。
 * 为此下面有一条"解析到了足够多的工具"的前置断言：正则一旦失效，
 * 那条会先红，而不是让"花集合 == 闸门集合"在两边都是空集时静默通过。
 */

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const TOOLS_SOURCE = stripComments(
  readFileSync(resolve(import.meta.dirname, 'tools.ts'), 'utf8'),
)

const TOOL_CARD_SOURCE = stripComments(
  readFileSync(resolve(import.meta.dirname, '../../components/chat/tool-card.tsx'), 'utf8'),
)

/** 按 `    name: tool({` 的缩进切出每个工具的定义块 */
function splitToolBlocks(source: string): Map<string, string> {
  const starts = [...source.matchAll(/^ {4}([A-Za-z_$][\w$]*): tool\(\{/gm)]

  const blocks = new Map<string, string>()
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].index
    const end = i + 1 < starts.length ? starts[i + 1].index : source.length
    blocks.set(starts[i][1], source.slice(start, end))
  }
  return blocks
}

describe('花钱的工具体现在源码里，闸门名单必须跟着动', () => {
  const blocks = splitToolBlocks(TOOLS_SOURCE)

  it('解析本身是有效的 —— 否则下面两条会在两边都是空集时静默通过', () => {
    expect(blocks.size).toBeGreaterThanOrEqual(10)
    for (const name of [
      'identifyGarment',
      'enqueueTryOn',
      'enqueueHairChange',
      'batchTryOn',
      'critiqueOutfit',
    ]) {
      expect([...blocks.keys()], `没有解析到工具 ${name}`).toContain(name)
    }
  })

  it('调用了 enqueueGeneration 的工具，与 SPENDING_TOOL_APPROVAL 的名单完全一致', () => {
    const spends = new Set<string>()
    for (const [name, block] of blocks) {
      // 只认真正的调用：注释已被剥掉，所以说明文字里提到 enqueueGeneration 不算
      if (/\benqueueGeneration\(/.test(block)) spends.add(name)
    }

    // 先证明这个推导不是空的：一个都没找到，说明匹配方式错了，而不是"没有花钱工具"
    expect(spends.size).toBeGreaterThan(0)
    expect(spends).toContain('enqueueTryOn')

    /*
     * 两个方向都要断言。
     *
     * 只写 `expect([...spends]).toEqual([...gated])` 会漏掉顺序差异，
     * 而下面这种双向的子集断言给出的失败信息更具体：
     * 多了谁、少了谁，一眼能看出是"忘了登记"还是"登记了不再花钱的工具"。
     */
    expect([...spends].sort()).toEqual([...Object.keys(SPENDING_TOOL_APPROVAL)].sort())
  })

  it('不花钱的工具一个都不在闸门里 —— 为几厘钱点确认会让闸门贬值', () => {
    const notSpending = [...blocks.keys()].filter(
      (name) => !/\benqueueGeneration\(/.test(blocks.get(name) as string),
    )

    expect(notSpending.length).toBeGreaterThan(0)
    for (const name of notSpending) {
      expect(Object.keys(SPENDING_TOOL_APPROVAL)).not.toContain(name)
    }
  })
})

describe('界面那一份花钱名单不能漂移', () => {
  /*
   * `SPENDING_TOOL_APPROVAL` 决定服务端**拦不拦**，
   * `tool-card.tsx` 里那个 `SPENDING_TOOLS` 决定界面**说不说**"会花钱"。
   *
   * 两者必须一致，但它们在两个包里（服务端的 tools.ts 会连数据库一起拖进客户端，
   * 不能直接 import），只能各写一份 —— 于是就成了漂移的温床：
   * 服务端拦住了，卡片却是一张安静的灰卡，用户只看到"确认要执行吗"，
   * 不知道自己在批准一笔消费。
   */
  const match = TOOL_CARD_SOURCE.match(/const SPENDING_TOOLS = new Set\(\[([^\]]*)\]\)/)

  it('能解析到界面那份名单', () => {
    expect(match, '没有在 tool-card.tsx 里找到 SPENDING_TOOLS 的定义').not.toBeNull()
  })

  it('与 SPENDING_TOOL_APPROVAL 逐项一致', () => {
    const names = [...(match as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((m) => m[1])

    expect(names.length).toBeGreaterThan(0)
    expect(names.sort()).toEqual([...Object.keys(SPENDING_TOOL_APPROVAL)].sort())
  })
})
