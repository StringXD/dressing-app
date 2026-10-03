import sharp from 'sharp'

/**
 * 长边上限。手机原图动辄 4000px+，传到上游模型前必须压下来：
 * 既省上传时间与费用，也避免触发上游的尺寸限制。
 * 2048 对试穿/换发型这类任务足够保留细节。
 */
export const MAX_DIMENSION = 2048

/** 输入体积上限。正常手机照片 3-8MB，20MB 足够宽松又能挡住异常文件。 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/** sharp 内置的解压炸弹防护上限（像素数） */
const LIMIT_INPUT_PIXELS = 100_000_000

const ACCEPTED_INPUT_FORMATS = new Set([
  'jpeg',
  'png',
  'webp',
  'avif',
  'tiff',
  'gif',
  'heif',
])

export class UnsupportedImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedImageError'
  }
}

export interface NormalizedImage {
  buffer: Buffer
  mime: 'image/webp'
  ext: 'webp'
  width: number
  height: number
  bytes: number
  /** 原图格式，用于日志与排查（"为什么这张 HEIC 失败了"） */
  sourceFormat: string
}

/**
 * 上传图片归一化。
 *
 * 做四件事，顺序有讲究：
 * ① `.rotate()` 无参 → 按 EXIF Orientation 摆正像素。
 *    必须放在 resize 之前：否则竖拍照片会先被按错误方向裁剪。
 * ② resize 到长边 ≤ 2048（不放大）。
 * ③ 转 webp。
 * ④ **剥离全部元数据** —— sharp 的默认行为就是剥离，因此这里刻意
 *    *不* 调用 `.withMetadata()` / `.keepExif()`。
 *    手机照片的 EXIF 里通常带 GPS 坐标，属于敏感个人信息，绝不能不删。
 *
 * 注意 ① 与 ④ 的关系：`.rotate()` 会**读取** EXIF 来定向，但输出仍不含 EXIF，
 * 两者不冲突。
 */
export async function normalizeImage(input: Buffer): Promise<NormalizedImage> {
  if (input.byteLength === 0) {
    throw new UnsupportedImageError('文件为空')
  }
  if (input.byteLength > MAX_UPLOAD_BYTES) {
    throw new UnsupportedImageError(
      `文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`,
    )
  }

  const pipeline = sharp(input, {
    failOn: 'error',
    limitInputPixels: LIMIT_INPUT_PIXELS,
  })

  // sharp 的类型是 `export = sharp`（CommonJS 风格），配合 esModuleInterop 时
  // 无法用 `sharp.Metadata` 引用命名空间里的类型。这里靠推导拿类型，避免绕这个坑。
  const meta = await pipeline.metadata().catch(() => null)

  if (meta === null) {
    // sharp 无法解析头部：不是图片、或格式不受支持（例如缺少 libheif 的 HEIC）
    throw new UnsupportedImageError('无法识别的图片格式，请上传 JPG / PNG / WebP')
  }

  if (!meta.format || !ACCEPTED_INPUT_FORMATS.has(meta.format)) {
    throw new UnsupportedImageError(
      `不支持的图片格式：${meta.format ?? '未知'}，请上传 JPG / PNG / WebP`,
    )
  }

  const result = await pipeline
    .rotate()
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 90 })
    .toBuffer({ resolveWithObject: true })

  return {
    buffer: result.data,
    mime: 'image/webp',
    ext: 'webp',
    width: result.info.width,
    height: result.info.height,
    bytes: result.data.byteLength,
    sourceFormat: meta.format,
  }
}

/**
 * 读取图片元数据，用于测试与诊断。
 * 单独的导出便于在测试里断言"输出确实不含 EXIF"。
 */
export async function readImageMetadata(input: Buffer) {
  return sharp(input).metadata()
}
