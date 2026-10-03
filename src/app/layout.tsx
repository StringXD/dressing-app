import type { Metadata } from 'next'

import './globals.css'

export const metadata: Metadata = {
  title: '穿搭模拟',
  description: '上传全身照，用 AI 换装与换发型，实时查看效果',
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  )
}
