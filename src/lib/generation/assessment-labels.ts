/**
 * 分析结论里的枚举 → 中文。
 *
 * 与 `generation/errors.ts` 同款做法：把映射做成纯函数，于是"上游英文枚举不上屏"
 * 这条规矩有了一个可单测的落点，而不是散在组件的 JSX 里。
 */

/**
 * 查表，查不到就把原值原样返回。
 *
 * **遇到没见过的枚举值时不渲染 `undefined`**，而是退回原值。这不是偷懒：
 * 结论是模型产出的，换个模型、改一次提示词都可能冒出新取值，而那时界面上
 * 出现一片空白或 "undefined"，比出现一个英文单词难查得多。
 */
function labelOf(map: Record<string, string>, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return ''
  return map[value] ?? value
}

const FIT_LABELS: Record<string, string> = {
  'too-tight': '偏紧',
  snug: '略紧但可接受',
  good: '合身',
  loose: '偏松',
  'too-loose': '过于宽松',
}

const COLOR_LABELS: Record<string, string> = {
  clashing: '配色冲突',
  acceptable: '配色尚可',
  good: '配色不错',
  excellent: '配色出色',
}

const SHAPE_LABELS: Record<string, string> = {
  pear: '梨形',
  apple: '苹果形',
  hourglass: '沙漏形',
  rectangle: 'H 形',
  'inverted-triangle': '倒三角形',
}

const SEASON_LABELS: Record<string, string> = {
  spring: '春季型',
  summer: '夏季型',
  autumn: '秋季型',
  winter: '冬季型',
}

export const fitLabel = (v: unknown) => labelOf(FIT_LABELS, v)
export const colorRatingLabel = (v: unknown) => labelOf(COLOR_LABELS, v)
export const bodyShapeLabel = (v: unknown) => labelOf(SHAPE_LABELS, v)
export const colorSeasonLabel = (v: unknown) => labelOf(SEASON_LABELS, v)

/** 结果卡片上要显示的那几行评价 */
export interface CritiqueView {
  /** 「合身 · 肩线正落在肩头」；没有这一项时为 null */
  fit: string | null
  color: string | null
  highlights: string[]
  suggestions: string[]
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : []
}

/**
 * 把已存的评价 payload 转成界面要的那几行。
 *
 * **输入是 `unknown`，不是 `Critique`。** 它来自 jsonb 列，只由写入时的代码
 * 保证形状：schema 演进过、或库被人手工改过之后，读回来的是别的东西。
 * 这里做结构检查而不是断言，是为了让"读不认识的结论"退化成少显示一行，
 * 而不是在渲染时抛一个整页白屏的错。
 *
 * 刻意不 import `assessments.ts` 里的 `critiqueSchema` 来校验：那个文件连着
 * 数据库，而这个函数要能在客户端组件里跑。为一个展示层的判断把 db 打进
 * 浏览器包，代价远大于收益。
 */
export function buildCritiqueView(payload: unknown): CritiqueView | null {
  if (!payload || typeof payload !== 'object') return null

  const record = payload as Record<string, unknown>
  const fit = ratingLine(record.fit, fitLabel)
  const color = ratingLine(record.color, colorRatingLabel)
  const highlights = stringArray(record.highlights)
  const suggestions = stringArray(record.suggestions)

  // 什么都没有就返回 null，让卡片整块不渲染 ——
  // 渲染一个只有标题的空框，比不渲染更像出了故障
  if (!fit && !color && highlights.length === 0 && suggestions.length === 0) return null

  return { fit, color, highlights, suggestions }
}

/** 拼一行「合身 · 肩线正落在肩头」；两项都缺时返回 null */
function ratingLine(section: unknown, label: (v: unknown) => string): string | null {
  if (!section || typeof section !== 'object') return null

  const { rating, notes } = section as Record<string, unknown>
  const parts = [label(rating), typeof notes === 'string' ? notes.trim() : ''].filter(
    (part) => part.length > 0,
  )

  return parts.length ? parts.join(' · ') : null
}
