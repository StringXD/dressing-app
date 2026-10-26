import sharp from 'sharp'

/**
 * AI 生成内容的**隐式标识**：把来源信息写进图片文件本身。
 *
 * ── 为什么必须写进文件，而不只是存在数据库里 ──────────────────
 * `assets.kind = 'generated'` 已经记着"这是我生成的"，但那条记录**不会跟着图走**：
 * 用户下载、转发、发到别处之后，那张图就只剩像素了 —— 没有人能看出它是不是拍的。
 * 隐式标识的意义正在于此：**来源跟着文件一起离开**。
 *
 * ── 与上传链路剥 EXIF 并不矛盾 ────────────────────────────────
 * `normalize.ts` 上传时会剥掉全部元数据，因为手机照片的 EXIF 里通常有 GPS，
 * 那属于用户的隐私。这里做的是**相反方向**的事：写进去的是我们自己署名的
 * 来源声明，不含任何关于用户的信息。两条规则的目标是一致的 ——
 * **文件里只应该有我们有意放进去的东西。**
 * 后来的人看到"一处删 EXIF、一处加 EXIF"时，别把这里也当成漏删。
 *
 * ── 最重要的一条约束：它绝不能拖垮存图 ────────────────────────
 * 这个函数跑在 `storeResult` 里 —— 那是**上游已经计费、我们还没落盘**的那一步。
 * 在那里抛任何错，代价是"钱花了、图没了"。所以它**永远不抛**：
 * 写不进去就原样返回上游的字节，少一个标识，而不是少一张图。
 * 这与 `output_download_failed` 那条铁律是同一个道理。
 */

/** 写进 EXIF 的署名。ASCII，避免不同解析器对编码的处理差异 */
export const AI_LABEL_SOFTWARE = 'dressing-app'
export const AI_LABEL_ARTIST = 'AI generated'
export const AI_LABEL_DESCRIPTION = 'AI-generated image'

/** 我们能重新编码并写入元数据的格式。sharp 写不了的格式一律原样透传 */
const LABELABLE = new Set(['image/webp', 'image/jpeg', 'image/png'])

const SHARP_FORMAT: Record<string, 'webp' | 'jpeg' | 'png'> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpeg',
  'image/png': 'png',
}

export interface LabeledImage {
  buffer: Buffer
  mime: string
  /** 标识到底写进去了没有。false 表示已降级为原样透传 */
  labeled: boolean
  /** 降级时带上原因，便于排查；正常时为 null */
  reason: string | null
}

export async function labelAsAiGenerated(bytes: Buffer, mime: string): Promise<LabeledImage> {
  if (!LABELABLE.has(mime)) {
    return {
      buffer: bytes,
      mime,
      labeled: false,
      reason: `不支持的输出格式 ${mime}，未写入标识`,
    }
  }

  try {
    const pipeline = sharp(bytes, { failOn: 'error' }).withMetadata({
      exif: {
        IFD0: {
          Software: AI_LABEL_SOFTWARE,
          Artist: AI_LABEL_ARTIST,
          ImageDescription: AI_LABEL_DESCRIPTION,
        },
      },
    })

    const format = SHARP_FORMAT[mime]

    /*
     * 按**上游给的格式**重新编码，而不是统一转 webp。
     *
     * 统一转格式听着更"整洁"，但它超出这件事的范围：mime 变了，
     * `storeResult` 的扩展名、已有产物的读取路径都得跟着改。
     * 标识不该顺手改动别的东西。
     *
     * 质量给到 95：这是一次有损重编码，而我们并不想让用户
     * 因为一个合规标识就把买来的图再糊一遍。
     */
    const output =
      format === 'webp'
        ? await pipeline.webp({ quality: 95 }).toBuffer()
        : format === 'jpeg'
          ? await pipeline.jpeg({ quality: 95 }).toBuffer()
          : await pipeline.png({ compressionLevel: 9 }).toBuffer()

    return { buffer: output, mime, labeled: true, reason: null }
  } catch (error) {
    /*
     * 故意吞掉：见文件头。少一个标识远好过少一张已经付过钱的图。
     *
     * 变异检验记录：把这里改成 `throw error` 后，"字节解析不了时原样返回"
     * 那条断言会以 `Input buffer contains unsupported image format` 变红。
     * 那个改动看起来更严格，实际是把一个合规标识排在了用户已付费的图前面。
     */
    return {
      buffer: bytes,
      mime,
      labeled: false,
      reason: `写入标识失败，已原样保存：${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}

/**
 * 读回标识，判断一张图是不是我们标过的 AI 生成内容。
 *
 * 用途是**排查与验收**：判断"这张图到底有没有带上来源信息"时，
 * 不该靠肉眼看不出差别就假定写成功了。
 *
 * 只做子串匹配而不解析 EXIF 结构：这是在回答"里面有没有我们那句署名"，
 * 而不是在做一个通用的 EXIF 解析器 —— 后者需要一个依赖，
 * 而它对这个项目没有任何别的用途。
 */
export async function hasAiLabel(bytes: Buffer): Promise<boolean> {
  try {
    const meta = await sharp(bytes).metadata()
    if (!meta.exif) return false
    return meta.exif.includes(AI_LABEL_DESCRIPTION)
  } catch {
    return false
  }
}
