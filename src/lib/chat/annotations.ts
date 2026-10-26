/**
 * 附件标注的编解码。
 *
 * 这里承载着"模型怎么知道该识别哪张图"：图片以 assetId 的形式写进消息文本，
 * Agent 拿着它去调 `identifyGarment`。编解码一旦对不上，模型就永远找不到图，
 * 而界面上不会有任何报错 —— 只是它一直说"我没看到图片"。
 *
 * 抽成不依赖 React 的纯函数，就是为了让这条往返能被单测直接看着。
 *
 * ── 为什么在 `lib/` 而不在 `components/chat/` ─────────────────────────
 * 服务端也要用它：落库时要生成对话标题（取首条用户消息的正文），
 * 那就必须先把标注行剥掉，否则标题会变成一行机器文本。
 * 放在组件目录里，就意味着 `lib/` 要反过来 import `components/` ——
 * 依赖方向是反的（见铁律 6）。这个模块本来就不依赖 React。
 */

/** 标注行前缀。模型看到它，用户看不到（渲染前会被剥掉） */
export const ATTACHMENT_PREFIX = '[附件]'

/**
 * 「工作台上选中的已识别服装」前缀。
 *
 * 与 `[附件]` 分开不是形式主义：两者带的是**不同的 id**。`[附件]` 带 assetId
 * （那张图），这一行带 garmentId（`batchTryOn` 要的那个）。合成一种写法的话，
 * 模型会拿 assetId 去当 garmentId 用 —— 那不会报错，只会让它说
 * "找不到这件衣服"，而用户明明在网格里看着它。
 */
export const SELECTION_PREFIX = '[选择]'

/** 所有给机器看的行前缀。渲染时要一并剥掉 */
export const ANNOTATION_PREFIXES = [ATTACHMENT_PREFIX, SELECTION_PREFIX] as const

export type AttachmentKind = 'person' | 'garment'

export interface Attachment {
  assetId: string
  kind: AttachmentKind
}

const KIND_LABEL: Record<AttachmentKind, string> = {
  person: '人物照',
  garment: '服装图',
}

/** 把附件写成一行给模型看的标注 */
export function formatAttachmentLine(attachment: Attachment): string {
  return `${ATTACHMENT_PREFIX} ${KIND_LABEL[attachment.kind]} assetId=${attachment.assetId}`
}

/**
 * 把工作台上选中的服装写成一行给模型看。
 *
 * 只带 garmentId，**不带图片地址**：地址由客户端给的话，这里就等于开了一个
 * 可被注入的参数位（`parseAttachmentLines` 只认 UUID 形状正是为了堵这个）。
 * 代价是这条线画不出缩略图 —— 用户刚刚才点过那些格子，他知道自己选了什么。
 */
export function formatGarmentSelectionLine(garmentId: string): string {
  return `${SELECTION_PREFIX} 服装 garmentId=${garmentId}`
}

/** 渲染时把标注行剥掉，只留用户真正打的字 */
export function stripAnnotationLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart()
      return !ANNOTATION_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
    })
    .join('\n')
    .trim()
}

/**
 * 从标注行里还原出附件。
 *
 * 只认服务端生成的 UUID 形状：assetId 会直接进工具调用，
 * 让任意字符串通过等于给模型一个可被注入的参数位。
 */
export function parseAttachmentLines(text: string): Attachment[] {
  const attachments: Attachment[] = []

  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith(ATTACHMENT_PREFIX)) continue

    const assetId = /assetId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(
      line,
    )?.[1]
    if (!assetId) continue

    attachments.push({
      assetId,
      kind: line.includes(KIND_LABEL.person) ? 'person' : 'garment',
    })
  }

  return attachments
}