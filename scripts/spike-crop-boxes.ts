/**
 * 探针：视觉模型给的包围盒，够不够用来裁图？
 *
 * `cropGarment` 的全部价值都压在一个假设上 —— **模型能给出可用的框**。
 * 如果框是歪的，裁出来的就只是"衣服的一角"，用户花 $0.075 试穿一张错图。
 * 这个脚本就是拿来验这个假设的，跑一次花几分钱文本 token（不调 fal）。
 *
 * 跑法：
 *   ./node_modules/.bin/tsx scripts/spike-crop-boxes.ts [整身照路径]
 *
 * 产物落在 spike-output/crops/：
 *   0.jpg 1.jpg … —— **真正要看的产物**：实际会入库的裁切结果
 *   boxes.jpg     —— 原图 + 画上去的框（辅助定位，**不能只看它**）
 *   raw.json      —— 模型的原始返回
 *
 * ⚠️ **验收必须看 `${i}.jpg`，不能只看 boxes.jpg。**
 * 踩过这个坑：标注标签画在框上方 44px 处，看标注图时会把标签边界误当成框边界，
 * 于是"框里有没有脸"这个判断反过来做对了也觉得对。
 */
import '@/lib/load-env'

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { generateObject } from 'ai'
import sharp from 'sharp'
import { z } from 'zod'

import { getAgentModel } from '@/lib/agent/model'

const OUT_DIR = path.join('spike-output', 'crops')

const boxSchema = z.object({
  x: z.number().min(0).max(1).describe('框左上角的 x，占整图宽的比例'),
  y: z.number().min(0).max(1).describe('框左上角的 y，占整图高的比例'),
  width: z.number().min(0).max(1).describe('框宽，占整图宽的比例'),
  height: z.number().min(0).max(1).describe('框高，占整图高的比例'),
})

const cropSchema = z.object({
  head: boxSchema.describe('照片里这个人**头部**的框：从头顶（含头发）到下巴，只框头'),
  items: z
    .array(
      z.object({
        title: z.string().min(1).describe('这件衣服是什么，一句中文，例如「米色长风衣」'),
        category: z
          .enum(['top', 'outerwear', 'bottom', 'dress'])
          .describe('类别。上装/外套/连衣裙属于"上部"，下装不属于'),
        box: boxSchema,
      }),
    )
    .min(1)
    .max(6)
    .describe('身上每一件可单独试穿的服装，一件一个框'),
})

const PROMPT = `这是一张真人照片。请做两件事。

**第一件：框出这个人的头。** 从头顶（含头发）到下巴，只框头本身，
不要带上肩膀。这个框后面会被用来把上装的框顶下去，所以下巴的位置要尽量准。

**第二件：找出他身上每一件可以单独试穿的服装**，每件给一个矩形框。

可以框的只有这四类：上衣、裤子、裙子、连衣裙、外套。
**不要框**鞋子、帽子、围巾、手套、腰带、手表、眼镜、包 —— 那些不能单独试穿。
最多 6 件；超过的场合只框最显眼的那几件。

框用相对整张图片的比例表示，原点在左上角，都是 0~1 的小数：
- x / y：框左上角在整图宽/高里的占比
- width / height：框本身占整图宽/高的比例

举例：一件上衣占了整张图上方中间，左上角在横向 35%、纵向 20% 处，宽占 30%、高占 25%，
就写 x=0.35、y=0.2、width=0.3、height=0.25。

衣服的框要注意：
- 上装的框从**衣领**开始，不要往上框到脖子、下巴或者脸
- 下装的框从**裤腰/裙腰**开始，到裤脚/裙摆结束
- 左右两侧贴紧衣服，不要把光着的胳膊或腿框进来
- 不要为了省事把整张照片框进来

上装的框给不准也没关系 —— **宁可给得靠上一点**，程序会用头部框把它顶下来。
但头部的框必须准。`

async function main() {
  const inputPath = process.argv[2] ?? path.join('spike-output', 'inputs', 'model.png')

  await mkdir(OUT_DIR, { recursive: true })

  const input = await readFile(inputPath)
  const meta = await sharp(input).metadata()
  const width = meta.width
  const height = meta.height
  if (!width || !height) throw new Error(`${inputPath} 读不出宽高，没法算框`)

  console.log(`输入：${inputPath}（${width}×${height}）`)

  const started = Date.now()
  const { object } = await generateObject({
    model: getAgentModel(),
    schema: cropSchema,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          {
            type: 'file',
            data: input,
            mediaType: meta.format === 'png' ? 'image/png' : 'image/jpeg',
          },
        ],
      },
    ],
  })

  const headBottom = object.head.y + object.head.height
  console.log(
    `模型返回 ${object.items.length} 件，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
  )
  console.log(`头部框：y=${object.head.y.toFixed(2)} 高=${object.head.height.toFixed(2)} → 下沿 ${headBottom.toFixed(2)}\n`)

  // 画框：用纯数字标签，librsvg 未必装了中文字体，中文会变成空白
  const rect = (box: { x: number; y: number; width: number; height: number }, stroke: string) =>
    `<rect x="${box.x * width}" y="${box.y * height}" width="${box.width * width}" height="${box.height * height}" fill="none" stroke="${stroke}" stroke-width="4"/>`

  const overlay = [
    rect(object.head, '#00aaff'),
    ...object.items.map((item) => rect(item.box, '#ff0044')),
  ].join('\n')

  await sharp(input)
    .composite([
      {
        input: Buffer.from(
          `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${overlay}</svg>`,
        ),
        top: 0,
        left: 0,
      },
    ])
    .jpeg({ quality: 88 })
    .toFile(path.join(OUT_DIR, 'boxes.jpg'))
  console.log(`画框图（蓝=头部框）：${path.join(OUT_DIR, 'boxes.jpg')}`)

  // 实际会入库的裁切：向外放 4%，避免贴边把衣角切掉
  const PAD = 0.04
  for (const [i, item] of object.items.entries()) {
    const left = Math.max(0, Math.round((item.box.x - PAD) * width))
    const right = Math.min(width, Math.round((item.box.x + item.box.width + PAD) * width))
    const bottom = Math.min(height, Math.round((item.box.y + item.box.height + PAD) * height))

    let top = Math.max(0, Math.round((item.box.y - PAD) * height))
    /*
     * 头部夹取放在 padding **之后**：放在之前的话，向外放的那一圈会把上沿
     * 重新拉回脸上，等于没夹。只有"上部"的衣服需要夹。
     *
     * 余量按**头高**算（而不是按图高）：模型的"头部框"实测下沿落在嘴的位置，
     * 没到下巴，直接用它的下沿会留下下半张脸。往下再让半个头高，正好盖住
     * 下巴到脖子那一段，又不会切到衣领。按头高算的好处是它跟着构图缩放 ——
     * 特写和全身照吃亏的程度一样。
     */
    if (item.category !== 'bottom') {
      top = Math.max(top, Math.round((headBottom + (object.head.height * 0.5)) * height))
    }

    const w = right - left
    const h = bottom - top
    if (w < 8 || h < 8) {
      console.log(`  ${i}. ${item.title} —— 框退化成 ${w}×${h}px，跳过`)
      continue
    }

    await sharp(input)
      .extract({ left, top, width: w, height: h })
      .jpeg({ quality: 88 })
      .toFile(path.join(OUT_DIR, `${i}.jpg`))
    console.log(
      `  ${i}. [${item.category}] ${item.title}  上沿 ${top}px（占 ${(top / height).toFixed(2)}）  裁=${w}×${h}px`,
    )
  }

  await writeFile(
    path.join(OUT_DIR, 'raw.json'),
    JSON.stringify({ inputPath, width, height, items: object.items, head: object.head }, null, 2),
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
