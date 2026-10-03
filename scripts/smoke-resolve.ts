/**
 * 链接解析的真实验证（阶段 5 的完成标准）。
 *
 * 两件事：
 *   1. 证明 `resolveProductLink` 对**真实链接**不抛未捕获异常 ——
 *      无论成功、被反爬、还是输入本身就是垃圾
 *   2. 产出一张按平台分的实际结果表。这正是阶段 0 需要的"可行性表"，
 *      而其中**不需要 Key 的部分现在就能测**，不必等万邦与 fal 的 Key。
 *
 * 用法：
 *   ./node_modules/.bin/tsx scripts/smoke-resolve.ts
 */

import './lib/load-env'

import { PLATFORM_LABELS } from '@/lib/domain'
import { resolveProductLink } from '@/lib/resolve/resolve'
import type { ResolveOutcome } from '@/lib/resolve/types'

interface Case {
  /** 表格里显示的名称 */
  label: string
  /** 真实输入：可以是链接，也可以是整段分享文案 */
  input: string
  /** 期望能自动解析；false 表示预期会落到 Tier D（用于标记"这是已知情况"） */
  expectResolvable: boolean
}

/**
 * 测试输入。
 *
 * ⚠️ 需要真实商品链接才有意义 —— 下面的京东链接是实测可打开的真实商品页
 * （茅台飞天，sku 100012043978）。其余平台的链接会随商品下架失效，
 * 这类探测的价值在于**验证链路行为**（是否抛异常、走到哪一档），
 * 而不在于"这个商品能不能解析"。链接失效时结果会退化为 Tier D，
 * 那同样是正确行为。
 */
const CASES: readonly Case[] = [
  {
    // 用来证明 structured 档位在**真实网络**上确实能取到图。
    // 试过的国内电商与品牌站（网易严选/小米/华为/SHEIN/优衣库/宜家）
    // 全都是 JS 渲染的空壳，HTML 里没有 og:image —— 这本身是重要结论。
    label: 'MDN 文档页（服务端渲染，有真图）',
    input: 'https://developer.mozilla.org/en-US/docs/Web/HTTP',
    expectResolvable: true,
  },
  {
    label: 'Next.js 官网（og:image 含查询串）',
    input: 'https://nextjs.org/docs',
    expectResolvable: true,
  },
  {
    label: '腾讯新闻首页（实测确实无 og:image）',
    input: 'https://news.qq.com/',
    expectResolvable: false,
  },
  {
    label: '京东商品页（实测可打开）',
    input: 'https://item.jd.com/100012043978.html',
    expectResolvable: false,
  },
  {
    label: '京东移动版',
    input: 'https://item.m.jd.com/product/100012043978.html',
    expectResolvable: false,
  },
  {
    label: '淘宝商品页',
    input: 'https://item.taobao.com/item.htm?id=625675320982',
    expectResolvable: false,
  },
  {
    label: '天猫商品页',
    input: 'https://detail.tmall.com/item.htm?id=625675320982',
    expectResolvable: false,
  },
  {
    // goods_id 是编的，所以这里应当**解析失败**：
    // 实测拼多多对不存在的商品会回一个 share_logo.jpg，
    // 装饰图过滤必须把它拦下 —— 否则用户会把站点 logo 当成商品图确认。
    label: '拼多多商品页（假 id，应被过滤）',
    input: 'https://mobile.yangkeduo.com/goods.html?goods_id=123456',
    expectResolvable: false,
  },
  { label: '小红书', input: 'https://www.xiaohongshu.com/explore', expectResolvable: false },
  { label: '得物', input: 'https://www.dewu.com/', expectResolvable: false },
]

/** 退化输入 —— 重点验证"不抛异常"，而不是能否解析 */
const DEGENERATE_CASES: readonly Case[] = [
  { label: '淘口令分享码', input: '8￥CZ3457abcdef￥ 复制打开淘宝', expectResolvable: false },
  {
    label: '淘宝分享文案',
    input: '【淘宝】https://item.taobao.com/item.htm?id=1 CZ3457 「风衣」点击链接直接打开',
    expectResolvable: false,
  },
  { label: '纯文字', input: '帮我换一件风衣', expectResolvable: false },
  { label: '空字符串', input: '', expectResolvable: false },
  { label: '只有标点', input: '？？？', expectResolvable: false },
  { label: '非法地址', input: 'https://', expectResolvable: false },
  { label: '内网短链（SSRF 探测）', input: 'https://m.tb.cn/h.evil', expectResolvable: false },
  { label: '不存在的域名', input: 'https://definitely-not-a-real-domain-xyz123.com/a', expectResolvable: false },
  { label: '裸域名', input: 'item.jd.com/100012043978.html', expectResolvable: false },
]

function ok(label: string, detail = ''): void {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
}

function fail(label: string, detail = ''): never {
  console.error(`  \x1b[31m✗\x1b[0m ${label}${detail ? `  ${detail}` : ''}`)
  process.exit(1)
}

function summarize(outcome: ResolveOutcome): string {
  if (outcome.ok) {
    return `命中 ${outcome.tier} · ${outcome.candidates.length} 张候选图`
  }

  // 失败的细节对诊断最重要：走了几档、每档为什么没成
  const ran = outcome.attempts.filter((a) => !a.detail.startsWith('跳过：'))
  const skipped = outcome.attempts.filter((a) => a.detail.startsWith('跳过：'))

  return `Tier D · 跑了 ${ran.length} 档 / 跳过 ${skipped.length} 档`
}

async function runCase(testCase: Case): Promise<ResolveOutcome> {
  const startedAt = Date.now()

  let outcome: ResolveOutcome
  try {
    outcome = await resolveProductLink(testCase.input)
  } catch (error) {
    // 这一条就是本阶段的核心验收标准：走到这里说明承诺被破坏了
    fail(
      `${testCase.label} 抛出了未捕获异常`,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    )
  }

  const elapsed = Date.now() - startedAt
  const platformLabel = PLATFORM_LABELS[outcome.platform]
  const mark = outcome.ok ? '\x1b[32m●\x1b[0m' : '\x1b[33m○\x1b[0m'

  console.log(
    `  ${mark} ${testCase.label.padEnd(30, ' ')} ${platformLabel.padEnd(8, ' ')} ` +
      `${summarize(outcome).padEnd(34, ' ')} ${elapsed}ms`,
  )

  return outcome
}

async function main(): Promise<void> {
  console.log('\n\x1b[1m链接解析验证\x1b[0m')
  console.log('  ● 表示自动解析成功，○ 表示降级到 Tier D（引导用户发截图）\n')

  console.log('── 各平台真实链接 ─────────────────────────────────────────────')
  const platformOutcomes: ResolveOutcome[] = []
  for (const testCase of CASES) {
    platformOutcomes.push(await runCase(testCase))
  }

  console.log('\n── 退化输入（重点验证不抛异常）──────────────────────────────')
  const degenerateOutcomes: ResolveOutcome[] = []
  for (const testCase of DEGENERATE_CASES) {
    degenerateOutcomes.push(await runCase(testCase))
  }

  // ── 断言 ────────────────────────────────────────────────────
  console.log('\n── 验收断言 ──────────────────────────────────────────────────')

  ok(`全部 ${CASES.length + DEGENERATE_CASES.length} 个输入都没有抛出未捕获异常`)

  const allOutcomes = [...platformOutcomes, ...degenerateOutcomes]

  const failed = allOutcomes.filter((o) => !o.ok)
  const allTerminal =
    failed.every((o) => o.tier === 'manual' && typeof o.reason === 'string' && o.reason.length > 0) &&
    allOutcomes.filter((o) => o.ok).every((o) => typeof o.tier === 'string')
  if (allTerminal) ok('失败的全部收敛为 Tier D，且都带了给用户看的说明')
  else fail('存在既未成功、又不是 Tier D 的结果')

  const hasCandidates = allOutcomes
    .filter((o) => o.ok)
    .every((o) => o.candidates.length > 0 && o.candidates.every((c) => c.imageUrl.startsWith('http')))
  if (hasCandidates) ok('所有成功结果都带回了可下载的候选图')
  else fail('有成功结果却没有候选图')

  // 结构化提取是本阶段唯一不需要 Key 就能工作的档位，
  // 它必须至少在一个**真实可达的站点**上真的跑通 —— 否则"能解析"只是纸面结论
  const structuredHits = platformOutcomes.filter((o) => o.ok && o.tier === 'structured')
  if (structuredHits.length > 0) {
    ok(`structured 档位在 ${structuredHits.length} 个真实站点上取到了图（非纸面结论）`)
  } else {
    fail('structured 档位未能在任何站点上取到图，说明实现或网络有问题')
  }

  // 预期与实际的比对。写死"应该能"或"应该不能"，
  // 一旦某个平台的行为变了（比如开始服务端渲染），这里会立刻响。
  const mismatches = CASES.map((testCase, i) => ({ testCase, outcome: platformOutcomes[i] })).filter(
    ({ testCase, outcome }) => outcome.ok !== testCase.expectResolvable,
  )

  if (mismatches.length === 0) {
    ok(`各平台的预期与实际一致（${CASES.length} 项）`)
  } else {
    for (const { testCase, outcome } of mismatches) {
      console.error(
        `  ! ${testCase.label}：预期${testCase.expectResolvable ? '可解析' : '不可解析'}，` +
          `实际${outcome.ok ? `可解析（${outcome.tier}）` : '不可解析'}`,
      )
    }
    fail(`${mismatches.length} 个平台的解析结果与预期不符（可能是平台行为变了，需重新评估）`)
  }

  const internalBlocked = degenerateOutcomes.some(
    (o) => !o.ok && JSON.stringify(o.attempts).includes('内网地址'),
  )
  ok(
    internalBlocked
      ? '内网短链被安全策略拦下（未跟随）'
      : '未触发内网拦截分支（该用例的短链域名未必真的解析到内网）',
  )

  // ── 平台可行性表 ────────────────────────────────────────────
  console.log('\n── 平台可行性表（实测）───────────────────────────────────────')
  console.log('  平台      自动解析  命中档位            说明')
  console.log('  ─────────────────────────────────────────────────────────────')

  for (let i = 0; i < CASES.length; i += 1) {
    const testCase = CASES[i]
    const outcome = platformOutcomes[i]

    const tier = outcome.ok ? outcome.tier : '—'
    const note = outcome.ok
      ? `${outcome.candidates.length} 张图`
      : outcome.attempts
          .filter((a) => !a.detail.startsWith('跳过：'))
          .map((a) => a.detail)
          .slice(0, 1)
          .join(' ')
          .slice(0, 46)

    console.log(
      `  ${testCase.label.slice(0, 8).padEnd(8, ' ')} ` +
        `${(outcome.ok ? '可以' : '不可以').padEnd(8, ' ')} ` +
        `${tier.padEnd(18, ' ')} ${note}`,
    )
  }

  console.log('\n\x1b[32m\x1b[1m全部通过\x1b[0m\n')
}

main().catch((error) => {
  console.error('\n\x1b[31m执行失败：\x1b[0m', error)
  process.exit(1)
})
