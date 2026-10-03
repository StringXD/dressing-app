/**
 * 拍摄指引。
 *
 * 不是装饰性文案：试穿模型对输入照片很敏感，构图不对会导致
 * 衣服位置错乱、脸被改掉、比例失真。把要求前置说明，
 * 比生成失败后再让用户猜要省事得多。
 */

const TIPS = [
  {
    icon: '🧍',
    title: '全身入镜',
    body: '从头顶到脚都要在画面里。半身照无法生成完整的穿搭效果。',
  },
  {
    icon: '🚶',
    title: '自然站立，正面朝向镜头',
    body: '手臂稍微离开身体，不要交叉或插兜，避免遮挡衣服轮廓。',
  },
  {
    icon: '☀️',
    title: '光线均匀',
    body: '白天靠窗或室内明亮处最好。避免逆光和强烈的侧向阴影。',
  },
  {
    icon: '🧱',
    title: '背景尽量简洁',
    body: '纯色墙面最佳。杂乱的背景会影响判断人物轮廓的准确性。',
  },
] as const

export function PhotoGuide({ className = '' }: { className?: string }) {
  return (
    <section className={className}>
      <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
        怎样拍出效果好的人像照
      </h2>
      <ul className="mt-3 space-y-3">
        {TIPS.map((tip) => (
          <li key={tip.title} className="flex gap-3">
            <span aria-hidden className="mt-0.5 text-lg leading-none">
              {tip.icon}
            </span>
            <div>
              <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
                {tip.title}
              </p>
              <p className="mt-0.5 text-sm text-neutral-500">{tip.body}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-4 rounded-xl bg-neutral-50 px-3 py-2 text-xs text-neutral-500 dark:bg-neutral-900">
        照片中的定位信息（EXIF）会在上传时自动清除，不会保留。
      </p>
    </section>
  )
}
