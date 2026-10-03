import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import {
  MAX_DIMENSION,
  MAX_UPLOAD_BYTES,
  normalizeImage,
  readImageMetadata,
  UnsupportedImageError,
} from './normalize'

/** 一个独特的标记串，用来在二进制里直接搜有没有残留 */
const SECRET_MARKER = 'SECRET_GPS_39.9042_116.4074'

/**
 * 造一张带 EXIF 的 JPEG 作为测试输入。
 *
 * EXIF 里放一个可搜索的标记串，这样断言不依赖 sharp 报告"是否含 EXIF"，
 * 而是直接在字节流里找 —— 更能证明"确实删干净了"。
 *
 * orientation 必须通过 `withMetadata({ orientation })` 写入：它是 SHORT 类型，
 * 以字符串形式塞进 withExif 的 IFD0 会被静默忽略（实测会退化成 1）。
 */
async function makeJpegWithExif(
  width: number,
  height: number,
  options: { orientation?: number } = {},
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 180, g: 120, b: 60 } },
  })
    .jpeg({ quality: 90 })
    .withExif({
      IFD0: {
        Make: 'TestCamera',
        Model: 'TestModel',
        ImageDescription: SECRET_MARKER,
      },
    })
    .withMetadata({ orientation: options.orientation })
    .toBuffer()
}

describe('normalizeImage', () => {
  describe('元数据剥离（隐私要求）', () => {
    it('输入确实带 EXIF —— 否则下面的测试就是空转', async () => {
      const input = await makeJpegWithExif(800, 600)

      // 先确认样本本身含有 EXIF，不然"输出没有 EXIF"这个断言毫无意义
      expect(input.includes(SECRET_MARKER)).toBe(true)
      const meta = await readImageMetadata(input)
      expect(meta.exif).toBeDefined()
    })

    it('输出的字节流里找不到任何 EXIF 标记串', async () => {
      const input = await makeJpegWithExif(800, 600)

      const result = await normalizeImage(input)

      expect(result.buffer.includes(SECRET_MARKER)).toBe(false)
    })

    it('输出的 metadata 里没有 exif 字段', async () => {
      const input = await makeJpegWithExif(800, 600)

      const result = await normalizeImage(input)
      const meta = await readImageMetadata(result.buffer)

      expect(meta.exif).toBeUndefined()
    })
  })

  describe('EXIF 方向校正', () => {
    it('Orientation=6 的横图，输出应变为竖图', async () => {
      // Orientation 6 = 顺时针旋转 90°，即"存储是横的，实际该竖着看"
      const input = await makeJpegWithExif(400, 200, { orientation: 6 })

      // 先验证样本构造成功：存储像素仍是 400x200，但 EXIF 标记了方向
      const inputMeta = await readImageMetadata(input)
      expect(inputMeta.width).toBe(400)
      expect(inputMeta.height).toBe(200)
      expect(inputMeta.orientation).toBe(6)

      const result = await normalizeImage(input)

      // .rotate() 已按 EXIF 摆正像素，因此宽高应互换
      expect(result.width).toBe(200)
      expect(result.height).toBe(400)
    })
  })

  describe('尺寸处理', () => {
    it('超长边被压到上限，且保持宽高比', async () => {
      const input = await sharp({
        create: { width: 4000, height: 2000, channels: 3, background: '#333' },
      })
        .jpeg()
        .toBuffer()

      const result = await normalizeImage(input)

      expect(result.width).toBe(MAX_DIMENSION)
      expect(result.height).toBe(MAX_DIMENSION / 2)
    })

    it('小图不会被放大', async () => {
      const input = await sharp({
        create: { width: 300, height: 200, channels: 3, background: '#333' },
      })
        .jpeg()
        .toBuffer()

      const result = await normalizeImage(input)

      expect(result.width).toBe(300)
      expect(result.height).toBe(200)
    })

    it('总是输出 webp 并报告正确的字节数', async () => {
      const input = await makeJpegWithExif(800, 600)

      const result = await normalizeImage(input)

      expect(result.mime).toBe('image/webp')
      expect(result.ext).toBe('webp')
      expect(result.sourceFormat).toBe('jpeg')
      expect(result.bytes).toBe(result.buffer.byteLength)
    })
  })

  describe('非法输入', () => {
    it('拒绝空文件', async () => {
      await expect(normalizeImage(Buffer.alloc(0))).rejects.toThrow(UnsupportedImageError)
    })

    it('拒绝非图片内容', async () => {
      const notAnImage = Buffer.from('这不是图片，只是一段普通文本。'.repeat(50))

      await expect(normalizeImage(notAnImage)).rejects.toThrow(UnsupportedImageError)
    })

    it('拒绝超过体积上限的文件', async () => {
      const tooBig = Buffer.alloc(MAX_UPLOAD_BYTES + 1)

      await expect(normalizeImage(tooBig)).rejects.toThrow(/上限/)
    })
  })
})
