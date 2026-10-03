/**
 * 用 fal 官方 OpenAPI schema 校验我们的参数映射。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 *
 * `paramMap.ts` 里的字段名与枚举取值是从文档写的。三个端点的字段名
 * **各不相同**（`model_image` vs `person_image_url`、`garment_photo_type`
 * 用下划线），写错一个字母要到真正调用时才暴露 —— 而那时已经花了钱，
 * 且错误信息往往只是"参数校验失败"，很难定位到是哪个键。
 *
 * fal 为每个端点公开了 OpenAPI schema，于是可以**零成本、零调用**
 * 地把我们的参数名与上游定义逐项比对。上游改了 schema 时这里会立刻响。
 *
 * ── 与单测的分工 ──────────────────────────────────────────────
 *
 * 单测断言的是"映射逻辑正确"（给定输入产出预期输出），用的是写死的期望值。
 * 本脚本断言的是"那些写死的期望值与上游当前定义一致"。
 * 少了后者，单测只能证明我们和自己一致。
 *
 * 用法：
 *   ./node_modules/.bin/tsx scripts/verify-fal-schema.ts
 */

import { ENDPOINT_MAPPINGS, mapParams, type ResolvedImageUrls } from '@/lib/providers/fal/paramMap'
import {
  GARMENT_CATEGORIES,
  HAIRSTYLES,
  HAIR_COLORS,
  TRYON_MODES,
  UPSTREAM_PHOTO_TYPES,
  type HairInput,
  type ImageInput,
  type TryOnInput,
} from '@/lib/providers/types'

const SCHEMA_URL = 'https://fal.ai/api/openapi/queue/openapi.json'

interface JsonSchema {
  type?: string
  enum?: unknown[]
  default?: unknown
  description?: string
}

interface OpenApiSpec {
  paths: Record<string, { post?: { requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> } } }>
  components: { schemas: Record<string, { properties?: Record<string, JsonSchema>; required?: string[] }> }
}

function ok(label: string, detail = ''): void {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`)
}

function bad(label: string, detail = ''): void {
  console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `  ${detail}` : ''}`)
}

async function fetchSpec(endpoint: string): Promise<OpenApiSpec> {
  const url = `${SCHEMA_URL}?endpoint_id=${endpoint}`
  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`获取 ${endpoint} 的 schema 失败：HTTP ${response.status}`)
  }

  return (await response.json()) as OpenApiSpec
}

/**
 * 找到请求体的输入 schema。
 *
 * 不能靠猜 schema 名字（`FashnTryOnV16Input` 这种命名随时会变），
 * 要顺着 requestBody 的 $ref 走 —— 那是 OpenAPI 定义的唯一权威路径。
 */
function resolveInputSchema(spec: OpenApiSpec, endpoint: string): { properties: Record<string, JsonSchema>; required: string[] } {
  const path = spec.paths[`/${endpoint}`]
  const ref = path?.post?.requestBody?.content?.['application/json']?.schema?.$ref

  if (!ref) {
    throw new Error(`${endpoint} 的 schema 里找不到 requestBody 的 $ref（OpenAPI 结构可能变了）`)
  }

  // $ref 形如 "#/components/schemas/FashnTryOnV16Input"
  const name = ref.split('/').pop()
  const schema = name ? spec.components.schemas[name] : undefined

  if (!schema?.properties) {
    throw new Error(`${endpoint} 的输入 schema ${name} 不存在或没有 properties`)
  }

  return { properties: schema.properties, required: schema.required ?? [] }
}

const image: ImageInput = { bytes: Buffer.from('x'), mime: 'image/webp', filename: 'a.webp' }

const tryOnInput: TryOnInput = {
  kind: 'tryon',
  person: image,
  garment: image,
  category: 'tops',
  mode: 'quality',
  garmentPhotoType: 'flat-lay',
}

const hairInput: HairInput = {
  kind: 'hair',
  person: image,
  hairstyle: 'bob_cut',
  color: 'balayage',
}

const URLS: ResolvedImageUrls = { person: 'https://x/p.webp', garment: 'https://x/g.webp' }

/** 实际会发出的参数，与各端点的样例输入一一对应 */
function producedParams(endpoint: string): Record<string, unknown> {
  const mapping = ENDPOINT_MAPPINGS[endpoint]
  if (!mapping) throw new Error(`未登记的端点：${endpoint}`)

  return mapParams(endpoint, mapping.kind === 'tryon' ? tryOnInput : hairInput, URLS)
}

/**
 * 比对某个字段的词表。
 * 两个方向都要查：漏了上游的取值、以及我们多出上游不认的取值。
 * 返回发现的问题数。
 */
function compareEnum(
  field: string,
  ours: readonly string[],
  properties: Record<string, JsonSchema>,
): number {
  const upstream = (properties[field]?.enum ?? []).map(String)

  if (upstream.length === 0) {
    bad(`${field} 在上游 schema 里没有枚举定义`, '（字段名可能已改名）')
    return 1
  }

  const missingUpstream = upstream.filter((v) => !ours.includes(v))
  const extraOurs = ours.filter((v) => !upstream.includes(v))

  if (missingUpstream.length === 0 && extraOurs.length === 0) {
    ok(`${field} 词表完全一致`, `${ours.length} 个取值`)
    return 0
  }

  if (missingUpstream.length > 0) {
    bad(`${field} 漏了上游取值`, missingUpstream.join(', '))
  }
  if (extraOurs.length > 0) {
    bad(`${field} 有上游不认的取值`, extraOurs.join(', '))
  }

  return missingUpstream.length + extraOurs.length
}

async function main(): Promise<void> {
  console.log('\n\x1b[1m用 fal 官方 schema 校验参数映射\x1b[0m')
  console.log('  零调用、零花费 —— 只读公开的 OpenAPI 定义\n')

  let problems = 0
  const endpoints = Object.keys(ENDPOINT_MAPPINGS)

  for (const endpoint of endpoints) {
    console.log(`▸ ${endpoint}`)

    let inputSchema: { properties: Record<string, JsonSchema>; required: string[] }
    try {
      const spec = await fetchSpec(endpoint)
      inputSchema = resolveInputSchema(spec, endpoint)
    } catch (error) {
      bad('获取 schema 失败', error instanceof Error ? error.message : String(error))
      problems += 1
      console.log()
      continue
    }

    const produced = producedParams(endpoint)
    const upstreamKeys = Object.keys(inputSchema.properties)

    // 1. 我们发出的每个键，上游都必须认识
    const unknownKeys = Object.keys(produced).filter((key) => !upstreamKeys.includes(key))
    if (unknownKeys.length === 0) {
      ok(`发出的 ${Object.keys(produced).length} 个参数名上游全部认识`)
    } else {
      bad('发出了上游不认识的参数', unknownKeys.join(', '))
      console.log(`     \x1b[2m上游接受的键：${upstreamKeys.join(', ')}\x1b[0m`)
      problems += unknownKeys.length
    }

    // 2. 上游的必填字段，我们都要提供
    const missingRequired = inputSchema.required.filter((key) => !(key in produced))
    if (missingRequired.length === 0) {
      ok(`上游要求的必填字段全部提供`, `required = ${inputSchema.required.join(', ')}`)
    } else {
      bad('缺少必填字段', missingRequired.join(', '))
      problems += missingRequired.length
    }

    // 3. 我们发出的枚举值，必须落在上游允许的集合里
    for (const [key, value] of Object.entries(produced)) {
      const allowed = inputSchema.properties[key]?.enum
      if (!allowed || typeof value !== 'string') continue

      if (allowed.includes(value)) {
        ok(`${key} 的取值在其枚举内`, `${value} ∈ [${allowed.join(', ')}]`)
      } else {
        bad(`${key} 的取值不在枚举内`, `我们发 ${value}，上游只接受 [${allowed.join(', ')}]`)
        problems += 1
      }
    }

    console.log()
  }

  // 4. 完整词表比对。这些是"多一个少一个都会出错"的硬约束 ——
  //    用户在下拉里选到的取值必须真的被上游接受。
  const ENUM_TABLES = [
    {
      title: '换发型端点',
      endpoint: 'fal-ai/image-apps-v2/hair-change',
      fields: [
        { field: 'target_hairstyle', ours: HAIRSTYLES },
        { field: 'hair_color', ours: HAIR_COLORS },
      ],
    },
    {
      title: '试穿端点',
      endpoint: 'fal-ai/fashn/tryon/v1.6',
      fields: [
        { field: 'category', ours: GARMENT_CATEGORIES },
        { field: 'mode', ours: TRYON_MODES },
        { field: 'garment_photo_type', ours: UPSTREAM_PHOTO_TYPES },
      ],
    },
  ] as const

  for (const table of ENUM_TABLES) {
    console.log(`▸ ${table.title}的枚举词表`)
    try {
      const spec = await fetchSpec(table.endpoint)
      const { properties } = resolveInputSchema(spec, table.endpoint)

      for (const { field, ours } of table.fields) {
        problems += compareEnum(field, ours, properties)
      }
    } catch (error) {
      bad('校验失败', error instanceof Error ? error.message : String(error))
      problems += 1
    }
    console.log()
  }

  console.log(
    problems === 0
      ? '\n\x1b[32m\x1b[1m参数映射与上游定义完全一致\x1b[0m\n'
      : `\n\x1b[31m\x1b[1m发现 ${problems} 处不一致 —— 需要修正 src/lib/providers 下的映射\x1b[0m\n`,
  )

  process.exit(problems === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('\n\x1b[31m执行失败：\x1b[0m', error)
  process.exit(1)
})
