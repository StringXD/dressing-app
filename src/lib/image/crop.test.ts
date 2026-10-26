import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { CROP_PADDING, MIN_CROP_PX, cropImage, toPixelBox } from './crop'

/**
 * 造一张上红下蓝的图，用来验"裁的到底是哪一块"。
 *
 * 只断言输出尺寸是不够的：`extract` 的 left/top 写反了，尺寸照样对，
 * 但裁出来的是另一半。颜色能把这个错误逼出来。
 */
async function makeTwoToneImage(width: number, height: number) {
  const half = Math.floor(height / 2)
  const red = await sharp({
    create: { width, height: half, channels: 3, background: { r: 255, g: 0, b: 0 } },
  })
    .png()
    .toBuffer()

  const blue = await sharp({
    create: { width, height: height - half, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer()

  return sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      { input: red, top: 0, left: 0 },
      { input: blue, top: half, left: 0 },
    ])
    .png()
    .toBuffer()
}

/** 取左上角第一个像素的 RGB */
async function firstPixelOf(buffer: Buffer) {
  const { data } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true })
  return { r: data[0], g: data[1], b: data[2] }
}

describe('toPixelBox', () => {
  it('把归一化比例换算成像素', () => {
    const box = toPixelBox({ x: 0.25, y: 0.25, width: 0.5, height: 0.25 }, 200, 400, 0)

    expect(box).toEqual({ left: 50, top: 100, width: 100, height: 100 })
  })

  it('向外放一圈，避免切掉衣领或下摆', () => {
    const box = toPixelBox({ x: 0.25, y: 0.25, width: 0.5, height: 0.25 }, 200, 400)

    // 上下左右各省 0.04 的图宽/图高
    expect(box).toEqual({
      left: 42,
      top: 84,
      width: 116,
      height: 132,
    })
  })

  it('默认的向外放量不为零', () => {
    // 这条防的是"把 padding 改成 0 却不自知"：那个改动会让衣角被切掉，
    // 而上面那条测试写的是显式传参的路径，发现不了默认值被改掉
    expect(CROP_PADDING).toBeGreaterThan(0)
  })

  it('把图外的框夹回图内，且绝不越界', () => {
    const box = toPixelBox({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, 1000, 1000, 0)

    expect(box).toEqual({ left: 900, top: 900, width: 100, height: 100 })

    /*
     * 这条才是重点：sharp 的 extract 一旦越界会直接抛错，
     * 而那个错会毁掉整批裁切 —— 明明只有一件衣服的框歪了。
     */
    expect(box!.left + box!.width).toBeLessThanOrEqual(1000)
    expect(box!.top + box!.height).toBeLessThanOrEqual(1000)
  })

  it('负坐标被夹到 0，宽度只算留在图内的部分', () => {
    // 框从 -0.2 伸到 0.3，留在图内的是 0~0.3
    const box = toPixelBox({ x: -0.2, y: -0.3, width: 0.5, height: 0.6 }, 1000, 1000, 0)

    expect(box).toEqual({ left: 0, top: 0, width: 300, height: 300 })
  })

  it('宽或高非正的框判掉', () => {
    expect(toPixelBox({ x: 0.1, y: 0.1, width: 0, height: 0.5 }, 1000, 1000)).toBeNull()
    expect(toPixelBox({ x: 0.1, y: 0.1, width: 0.5, height: -0.2 }, 1000, 1000)).toBeNull()
  })

  it('小到不成样子的框判掉', () => {
    // 1000×1000 上的 1% —— 10px，多半指向腰带或纽扣，不是一件衣服
    expect(toPixelBox({ x: 0.5, y: 0.5, width: 0.01, height: 0.01 }, 1000, 1000, 0)).toBeNull()

    // 刚好够到下限时应当通过，否则上面那条可能只是被别的条件挡掉的
    const justEnough = MIN_CROP_PX / 1000
    expect(
      toPixelBox({ x: 0.5, y: 0.5, width: justEnough, height: justEnough }, 1000, 1000, 0),
    ).toEqual({
      left: 500,
      top: 500,
      width: MIN_CROP_PX,
      height: MIN_CROP_PX,
    })
  })

  it('非有限数判掉，而不是一路传到 sharp', () => {
    const nan = { x: Number.NaN, y: 0.1, width: 0.5, height: 0.5 }
    expect(toPixelBox(nan, 1000, 1000)).toBeNull()

    const infinite = { x: 0.1, y: 0.1, width: Number.POSITIVE_INFINITY, height: 0.5 }
    expect(toPixelBox(infinite, 1000, 1000)).toBeNull()

    // 图本身读不出宽高时也一样
    expect(toPixelBox({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, 0, 1000)).toBeNull()
  })
})

describe('cropImage', () => {
  /*
   * 下面两条用的框**刻意避开中线**。
   *
   * `cropImage` 走的是默认 padding：一个 `y=0.5` 的框实际从 0.46 起算，
   * 在 800 高的图上 top=368 —— 落在红色区（红占 0~400）里。
   * 换句话说，"y=0.5 应当裁到蓝色"这个直觉是错的，padding 会把它推回红区。
   * 用 0.6 起算的框，断言才真的是在问"裁的是哪一块"。
   */
  it('裁出来的是框住的那块像素，不是另一半', async () => {
    const source = await makeTwoToneImage(400, 800)

    const bottom = await cropImage(source, { x: 0, y: 0.6, width: 1, height: 0.4 })
    expect(bottom).not.toBeNull()
    /*
     * 断言"是蓝色"而不是"等于 #0000ff"：输出走的是质量 90 的 JPEG，
     * 实测蓝通道回来是 254 而不是 255。要求精确值等于要求一个有损编码器
     * 无损 —— 那种断言会随机变红，而红得毫无信息。
     * 判据仍然能真的失败：区域裁错时这里会拿到红色（r≈255, b≈0）。
     */
    const bottomPixel = await firstPixelOf(bottom!.buffer)
    expect(bottomPixel.b).toBeGreaterThan(200)
    expect(bottomPixel.r).toBeLessThan(60)

    // 上半部分（红）—— 没有这条，把 y 和 height 写反了也测不出来
    const top = await cropImage(source, { x: 0, y: 0, width: 1, height: 0.4 })
    const topPixel = await firstPixelOf(top!.buffer)
    expect(topPixel.r).toBeGreaterThan(200)
    expect(topPixel.b).toBeLessThan(60)
  })

  it('输出尺寸等于框的尺寸', async () => {
    const source = await makeTwoToneImage(400, 800)

    const cropped = await cropImage(source, { x: 0.25, y: 0.25, width: 0.5, height: 0.25 })

    // 传给 sharp 的是 pad 过的框，读回来的宽高应当与之一致
    expect(cropped!.width).toBe(400 * 0.5 + 2 * Math.floor(400 * CROP_PADDING))
    expect(cropped!.height).toBe(800 * 0.25 + 2 * Math.floor(800 * CROP_PADDING))
  })

  it('输出是 JPEG', async () => {
    const source = await makeTwoToneImage(400, 800)
    const cropped = await cropImage(source, { x: 0, y: 0, width: 0.5, height: 0.5 })

    expect(cropped!.mime).toBe('image/jpeg')
    await expect(sharp(cropped!.buffer).metadata()).resolves.toMatchObject({ format: 'jpeg' })
  })

  it('框不成立时返回 null，不抛错', async () => {
    const source = await makeTwoToneImage(400, 800)

    expect(await cropImage(source, { x: 0.5, y: 0.5, width: 0.01, height: 0.01 })).toBeNull()
    expect(await cropImage(source, { x: 0.5, y: 0.5, width: 0, height: 0.5 })).toBeNull()
  })

  it('字节解不出来时抛能指认问题的错，而不是安静地返回 null', async () => {
    /*
     * 这条刻意要求**抛错**而不是 null：null 的含义是"这个框不行"，
     * 而源图坏掉是链路故障，混在一起会让调用方把它报成"框没框好"。
     */
    await expect(
      cropImage(Buffer.from('这不是图'), { x: 0, y: 0, width: 1, height: 1 }),
    ).rejects.toThrow(/损坏/)
  })
})
