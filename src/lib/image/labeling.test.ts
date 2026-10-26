import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import {
  AI_LABEL_DESCRIPTION,
  hasAiLabel,
  labelAsAiGenerated,
} from '@/lib/image/labeling'

/**
 * 守的是两件方向相反的事，而它们都关乎钱与合规：
 *
 * 1. **标识真的写进去了** —— 光在数据库里记一句"这是生成的"没用，
 *    用户把图存下来、转发出去之后就只剩像素了。
 * 2. **写不进去时绝不能把图搞丢** —— 这个函数跑在 `storeResult` 里，
 *    那是"上游已经计费、我们还没落盘"的一步。在那里抛错，
 *    代价是钱花了、图没了。
 *
 * 第二条是这套东西里最容易被"顺手改成更严格"的地方：
 * catch 改成 rethrow 看起来像是更负责任，实际是把一个合规标识
 * 排在了用户已经付过钱的图前面。
 */

/** 造一张真实的小图，避免用桩字节 —— 这个模块的行为全在 sharp 上 */
async function makeImage(format: 'webp' | 'jpeg' | 'png'): Promise<Buffer> {
  const pipeline = sharp({
    create: { width: 48, height: 32, channels: 3, background: { r: 180, g: 120, b: 90 } },
  })

  if (format === 'webp') return pipeline.webp().toBuffer()
  if (format === 'jpeg') return pipeline.jpeg().toBuffer()
  return pipeline.png().toBuffer()
}

describe('三种产物格式都能写入标识', () => {
  it.each([
    ['image/webp', 'webp'],
    ['image/jpeg', 'jpeg'],
    ['image/png', 'png'],
  ] as const)('%s 写进去并且能读回来', async (mime, format) => {
    const source = await makeImage(format)

    const result = await labelAsAiGenerated(source, mime)

    expect(result.labeled).toBe(true)
    expect(result.reason).toBeNull()
    expect(result.mime).toBe(mime)

    // 读回来看得到，才是真的写进去了。
    // 只看 `labeled: true` 会被一个"什么都没做却报告成功"的实现骗过去
    expect(await hasAiLabel(result.buffer)).toBe(true)
  })
})

describe('降级路径：绝不因为标识而丢掉已经付过钱的图', () => {
  it('字节根本解析不了时原样返回，不抛错', async () => {
    const garbage = Buffer.from('这不是一张图片')

    const result = await labelAsAiGenerated(garbage, 'image/webp')

    expect(result.labeled).toBe(false)
    expect(result.reason).toContain('已原样保存')
    // 原样指的是**同一个 buffer 的内容**，不是"随便返回点东西"
    expect(result.buffer.equals(garbage)).toBe(true)
  })

  it('sharp 写不了的格式直接透传，连试都不试', async () => {
    const bytes = await makeImage('png')

    const result = await labelAsAiGenerated(bytes, 'image/tiff')

    expect(result.labeled).toBe(false)
    expect(result.reason).toContain('image/tiff')
    expect(result.buffer.equals(bytes)).toBe(true)
  })

  it('降级时**不改变 mime** —— 改了就与字节的实际格式对不上', async () => {
    const result = await labelAsAiGenerated(Buffer.from('坏字节'), 'image/jpeg')

    expect(result.mime).toBe('image/jpeg')
  })
})

describe('标识的内容', () => {
  it('写的是一个可被机器读到的来源声明，而不是一句给人看的文案', async () => {
    const source = await makeImage('jpeg')

    const result = await labelAsAiGenerated(source, 'image/jpeg')
    const meta = await sharp(result.buffer).metadata()

    expect(meta.exif).toBeDefined()
    expect(meta.exif!.toString('latin1')).toContain(AI_LABEL_DESCRIPTION)
  })

  it('重新编码后仍然是一张能正常解码的图', async () => {
    const source = await makeImage('png')

    const result = await labelAsAiGenerated(source, 'image/png')
    const meta = await sharp(result.buffer).metadata()

    // 写标识时把图搞坏了，比不写标识更糟 —— 那是用户直接看得见的损失
    expect(meta.width).toBe(48)
    expect(meta.height).toBe(32)
  })
})

describe('hasAiLabel 的判定', () => {
  it('没有元数据的图返回 false', async () => {
    expect(await hasAiLabel(await makeImage('webp'))).toBe(false)
  })

  it('坏字节返回 false 而不是抛错 —— 它的用途是排查，不该自己成为故障源', async () => {
    expect(await hasAiLabel(Buffer.from('不是图片'))).toBe(false)
  })
})
