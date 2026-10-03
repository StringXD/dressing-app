import { PhotoGuide } from '@/components/photo-guide'
import { UploadDropzone } from '@/components/upload-dropzone'
import { hasEnv } from '@/lib/env'

/** 依赖项清单：缺什么、去哪儿拿、影响哪个功能 */
const SETUP_ITEMS = [
  {
    key: 'FAL_KEY' as const,
    label: 'fal.ai',
    purpose: '试穿与换发型的图像生成',
    affects: ['试衣间', '换发型'],
  },
  {
    key: 'ONEBOUND_KEY' as const,
    label: '万邦开放平台',
    purpose: '淘宝 / 天猫 / 京东 商品链接解析',
    affects: ['链接换装'],
  },
  {
    key: 'FIRECRAWL_API_KEY' as const,
    label: 'Firecrawl',
    purpose: '国际品牌站商品页解析（降级链第二级）',
    affects: ['链接换装'],
  },
  {
    key: 'ANTHROPIC_API_KEY' as const,
    label: 'LLM（Agent）',
    purpose: '对话式 Agent 与服装识别',
    affects: ['对话交互'],
  },
]

export default function Home() {
  const missing = SETUP_ITEMS.filter((item) => !hasEnv(item.key))

  return (
    <main className="mx-auto w-full max-w-2xl px-5 py-10 sm:py-16">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">穿搭模拟</h1>
        <p className="mt-2 text-sm text-neutral-500">
          上传一张全身照，换上不同衣服和发型，直接看效果。
        </p>
      </header>

      {missing.length > 0 && (
        <section className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950">
          <h2 className="text-sm font-medium text-amber-900 dark:text-amber-200">
            开发进度：还缺 {missing.length} 项配置
          </h2>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            上传功能已可用；生成类功能需要下列 Key。填写到项目根目录的{' '}
            <code className="rounded bg-amber-100 px-1 dark:bg-amber-900">.env</code>{' '}
            后重启即可。
          </p>
          <ul className="mt-3 space-y-2">
            {missing.map((item) => (
              <li key={item.key} className="text-xs">
                <span className="font-medium text-amber-900 dark:text-amber-200">
                  {item.label}
                </span>
                <span className="text-amber-700 dark:text-amber-400">
                  {' '}
                  · {item.purpose} · 影响：{item.affects.join('、')}
                </span>
                <br />
                <code className="text-amber-600 dark:text-amber-500">{item.key}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-medium">第一步：上传你的全身照</h2>
        <UploadDropzone
          label="上传全身照"
          hint="支持 JPG / PNG / WebP，会自动压缩并清除定位信息"
        />
      </section>

      <PhotoGuide className="mt-10" />
    </main>
  )
}
