/**
 * 上传链路端到端验证。
 *
 * 与 normalize.test.ts 的单测互补：单测验的是函数行为，
 * 这里验的是**真实 HTTP 链路** —— 上传接口、会话 cookie、存储落盘、
 * 图片读取路由的归属校验，以及最终落盘文件里确实没有 EXIF。
 *
 * 用法：
 *   1. 先起服务：npm run dev
 *   2. 另开终端：./node_modules/.bin/tsx scripts/smoke-upload.ts
 */

import sharp from 'sharp'

const BASE_URL = process.env.APP_URL ?? 'http://localhost:4000'

/** 与单测用同一个标记串，便于直接搜字节流 */
const SECRET_MARKER = 'SECRET_GPS_39.9042_116.4074'

function ok(label: string, detail = ''): void {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
}

function fail(label: string, detail = ''): never {
  console.error(`  \x1b[31m✗\x1b[0m ${label}${detail ? `  ${detail}` : ''}`)
  process.exit(1)
}

function assert(condition: unknown, label: string, detail = ''): asserts condition {
  if (condition) ok(label, detail)
  else fail(label, detail)
}

/**
 * 造一张"手机直出照片"：
 *
 * 真机竖拍时传感器仍以**横向**存像素（2400×1600），再用 EXIF Orientation=6
 * 表示"显示时需顺时针旋转 90°"。所以这里也这么造，否则样本不真实 ——
 * 归一化里 `.rotate()` 的整条路径就测不到。
 */
async function makePhoneLikeJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 2400, height: 1600, channels: 3, background: { r: 120, g: 140, b: 170 } },
  })
    .jpeg({ quality: 90 })
    .withExif({
      IFD0: {
        Make: 'TestPhone',
        Model: 'TestPhone 15 Pro',
        ImageDescription: SECRET_MARKER,
      },
    })
    .withMetadata({ orientation: 6 })
    .toBuffer()
}

async function main(): Promise<void> {
  console.log(`\n\x1b[1m上传链路 smoke 测试\x1b[0m  →  ${BASE_URL}\n`)

  // ── 0. 服务可达性 ────────────────────────────────────────────
  console.log('0. 服务可达性')
  const health = await fetch(`${BASE_URL}/api/health`).catch(() => null)
  if (!health) fail('无法连接服务', `请先运行 npm run dev（期望端口 ${BASE_URL}）`)
  const healthBody = (await health.json()) as { ok: boolean; db: string }
  assert(healthBody.ok && healthBody.db === 'up', '服务与数据库均正常')

  // ── 1. 造样本 ───────────────────────────────────────────────
  console.log('\n1. 构造测试样本（横向存储 2400×1600 + Orientation=6 + GPS 标记）')
  const source = await makePhoneLikeJpeg()
  assert(source.includes(SECRET_MARKER), '样本含 GPS 标记', `${(source.length / 1024).toFixed(0)}KB`)
  assert(
    (await sharp(source).metadata()).orientation === 6,
    '样本带 Orientation=6',
  )

  // ── 2. 上传 ─────────────────────────────────────────────────
  console.log('\n2. 上传')
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(source)], { type: 'image/jpeg' }), 'photo.jpg')

  const uploadRes = await fetch(`${BASE_URL}/api/upload`, { method: 'POST', body: form })
  const uploadBody = (await uploadRes.json()) as {
    assets: Array<{ id: string; url: string; width: number; height: number; bytes: number }>
    failed: Array<{ filename: string; reason: string }>
  }

  assert(uploadRes.status === 200, '上传返回 200', `status=${uploadRes.status}`)
  assert(uploadBody.assets.length === 1, '返回 1 个 asset')
  assert(uploadBody.failed.length === 0, '无失败项')

  const asset = uploadBody.assets[0]

  // 断言"有意义的性质"而不是写死魔数：
  // 输入长边 2400 → 应被压到 2048；且方向已摆正为竖图；宽高比保持 1600:2400 = 2:3
  assert(
    Math.max(asset.width, asset.height) === 2048,
    '长边压到上限 2048',
    `实际 ${asset.width}×${asset.height}`,
  )
  assert(asset.height > asset.width, '方向已摆正为竖图', `${asset.width}×${asset.height}`)
  assert(
    Math.abs(asset.width / asset.height - 2 / 3) < 0.01,
    '宽高比保持 2:3',
    `${(asset.width / asset.height).toFixed(4)}`,
  )

  // 会话 cookie：上传接口应当已下发
  const cookies = uploadRes.headers.getSetCookie()
  assert(cookies.length > 0, '下发了会话 cookie', cookies[0]?.split(';')[0])
  const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ')

  // ── 3. 读回并验证 ───────────────────────────────────────────
  console.log('\n3. 读回并验证落盘内容')
  const fileRes = await fetch(`${BASE_URL}${asset.url}`, {
    headers: { cookie: cookieHeader },
  })
  assert(fileRes.status === 200, '凭会话 cookie 可读取', `status=${fileRes.status}`)

  const stored = Buffer.from(await fileRes.arrayBuffer())
  assert(stored.length > 0, '读回非空', `${(stored.length / 1024).toFixed(0)}KB`)

  const storedMeta = await sharp(stored).metadata()
  assert(storedMeta.format === 'webp', '已转为 webp', `format=${storedMeta.format}`)
  assert(storedMeta.exif === undefined, '落盘文件不含 EXIF')
  assert(!stored.includes(SECRET_MARKER), '字节流中搜不到 GPS 标记')
  assert(
    (storedMeta.orientation ?? 1) === 1,
    '方向标记已归一（像素已摆正，无需再旋转）',
  )

  // ── 4. 归属校验 ─────────────────────────────────────────────
  console.log('\n4. 归属校验（无 cookie 应读不到）')
  const anonRes = await fetch(`${BASE_URL}${asset.url}`)
  assert(anonRes.status === 404, '无会话 cookie 时返回 404', `status=${anonRes.status}`)

  // ── 5. 路径穿越防护 ─────────────────────────────────────────
  console.log('\n5. 路径穿越防护')
  const traversal = await fetch(`${BASE_URL}/api/files/uploads/../../../package.json`, {
    headers: { cookie: cookieHeader },
  })
  assert(
    traversal.status === 404 || traversal.status === 400,
    '穿越尝试被拒绝',
    `status=${traversal.status}`,
  )

  console.log('\n\x1b[32m\x1b[1m全部通过\x1b[0m\n')
}

main().catch((error) => {
  console.error('\n\x1b[31m执行失败：\x1b[0m', error)
  process.exit(1)
})
