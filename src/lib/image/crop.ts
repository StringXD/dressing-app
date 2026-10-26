import sharp from 'sharp'

import { readImageMetadata } from './normalize'

/**
 * 按件裁图：把整身照里的一件衣服裁出来，当它自己的服装图。
 *
 * 框由视觉模型给出，是**归一化比例**（0~1，相对整图）。这里负责把比例换成像素、
 * 处理越界，并把不合格的框判掉。
 *
 * **为什么要向外放一圈**：模型的框本来就有几像素偏差 —— 实测一件连衣裙的框把
 * 两侧手臂各带进来一点。这里刻意选择"宁可多带背景，也不要切掉衣领或下摆"：
 * 切掉的部分上游补不回来（试穿模型看不到的布料它编不出来），而多出来的背景
 * 基本都是纯色或虚化，试穿模型会忽略。
 */

/** 归一化框：四个数都是相对整图的比例，原点在左上角 */
export interface NormalizedBox {
  x: number
  y: number
  width: number
  height: number
}

/** 像素框，直接喂给 sharp 的 extract */
export interface PixelBox {
  left: number
  top: number
  width: number
  height: number
}

/**
 * 裁出来的图小于这个尺寸就不算一件衣服。
 *
 * 64px 是保守下限。注意真正的瓶颈在**原图尺寸**而不是这里：实测一张 270×360 的
 * 示例图裁出来的裤子只有 130×209px，交给试穿上游必然是糊的。所以本模块只能
 * 挡掉"小到不成样子"的框，挡不掉"原图本来就不够大"这件事。
 */
export const MIN_CROP_PX = 64

/** 向外放的比例，按整图宽/高分别算 */
export const CROP_PADDING = 0.04

/**
 * 归一化框 → 像素框。框不成立时返回 `null`（而不是抛错或裁个残次品）。
 *
 * 返回 `null` 的三种情形，语义完全不同，调用方要分开对待：
 *   1. 数值不是有限数 —— 模型输出被截断或退化时的垃圾
 *   2. 宽高非正 —— 压根没有面积，不是"框不准"
 *   3. 裁出来小于 `MIN_CROP_PX` —— 框太小，多半指向了腰带、纽扣之类的局部
 */
export function toPixelBox(
  box: NormalizedBox,
  imageWidth: number,
  imageHeight: number,
  padding: number = CROP_PADDING,
): PixelBox | null {
  const numbers = [box.x, box.y, box.width, box.height, imageWidth, imageHeight, padding]
  /*
   * 先挡非有限数：NaN 一路传到 sharp 会报一个跟"框不准"毫无关系的错，
   * 排查时会被引到完全错误的方向。
   */
  if (!numbers.every(Number.isFinite)) return null

  if (box.width <= 0 || box.height <= 0) return null
  if (imageWidth <= 0 || imageHeight <= 0) return null

  /*
   * 夹回图内。模型确实会给图外的框（x=0.9 而 width=0.5），
   * 而 sharp 的 extract 一旦越界就直接抛错 —— 那会毁掉整批裁切，
   * 明明只有一件衣服的框歪了。
   *
   * floor / ceil 配对是刻意的：left 向下取整、right 向上取整，得到的
   * 区域只会比理论值大一点点；关键是**保证 left + width ≤ imageWidth**，
   * 这正是 sharp 要求的。
   */
  const left = Math.max(0, Math.floor((box.x - padding) * imageWidth))
  const top = Math.max(0, Math.floor((box.y - padding) * imageHeight))
  const right = Math.min(imageWidth, Math.ceil((box.x + box.width + padding) * imageWidth))
  const bottom = Math.min(imageHeight, Math.ceil((box.y + box.height + padding) * imageHeight))

  const width = right - left
  const height = bottom - top
  if (width < MIN_CROP_PX || height < MIN_CROP_PX) return null

  return { left, top, width, height }
}

export interface CroppedImage {
  buffer: Buffer
  mime: 'image/jpeg'
  width: number
  height: number
}

/**
 * 真的裁一刀。框不成立（或图片读不出宽高）时返回 `null`。
 *
 * 输出统一转 JPEG：源图是上传时归一化过的 webp，而下游试穿端点对 JPEG
 * 的支持最没有悬念。裁切区域来自照片，不可能有透明像素，因此丢 alpha 无损。
 */
export async function cropImage(input: Buffer, box: NormalizedBox): Promise<CroppedImage | null> {
  let width: number | undefined
  let height: number | undefined

  try {
    const meta = await readImageMetadata(input)
    width = meta.width
    height = meta.height
  } catch {
    /*
     * 字节解不出元数据 = 根本不是图片（或已损坏）。
     *
     * 这跟"框不准"必须分开：框不准是常态，跳过这一件就好；**源图坏掉是链路故障**，
     * 静默变成 `null` 的话会被调用方报成"这件衣服的框没框好"，把排查引到完全
     * 错误的方向。所以这里换成一句能指认问题的中文再抛出去。
     */
    throw new Error('图片的字节解不出来，可能已损坏，请重新上传')
  }

  if (!width || !height) return null

  const pixelBox = toPixelBox(box, width, height)
  if (!pixelBox) return null

  const buffer = await sharp(input).extract(pixelBox).jpeg({ quality: 90 }).toBuffer()

  return { buffer, mime: 'image/jpeg', width: pixelBox.width, height: pixelBox.height }
}
