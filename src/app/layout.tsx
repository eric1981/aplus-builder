import type { Metadata } from "next";
import "./globals.css";
import AmazonNav from "../components/AmazonNav";

export const metadata: Metadata = {
  title: "电商详情页生成器",
  description: "上传产品图片，自动生成专业电商详情页 HTML",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,300..700&family=Noto+Sans+SC:wght@300..700&family=Noto+Serif+SC:wght@300..700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen flex flex-col">
        <AmazonNav />
        <main className="flex-1">{children}</main>
        {/* 亚马逊风格页脚 */}
        <footer className="amz-footer mt-12">
          <div className="max-w-[1500px] mx-auto px-4 py-10">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-sm">
              <div>
                <p className="font-semibold text-white mb-3">
                  <span className="text-[#ff9900]">aplus</span>-builder
                </p>
                <p className="text-xs text-gray-400 leading-relaxed">
                  Amazon A+ 视觉工业流水线：产品图 → AI 生图 → 详情页排版 → 交付
                </p>
              </div>
              <div>
                <p className="font-semibold text-white mb-3">开始使用</p>
                <ul className="space-y-2 text-xs text-gray-300">
                  <li><a href="/build" className="hover:text-white">生成详情页</a></li>
                  <li><a href="/output" className="hover:text-white">查看产出</a></li>
                  <li><a href="/style-extract" className="hover:text-white">风格复刻</a></li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-white mb-3">客户与后台</p>
                <ul className="space-y-2 text-xs text-gray-300">
                  <li><a href="/customers" className="hover:text-white">客户档案</a></li>
                  <li><a href="/admin" className="hover:text-white">管理后台</a></li>
                  <li><a href="/login" className="hover:text-white">登录</a></li>
                </ul>
              </div>
              <div>
                <p className="font-semibold text-white mb-3">技术栈</p>
                <ul className="space-y-2 text-xs text-gray-300">
                  <li>Next.js 16 · React 19 · SQLite</li>
                  <li>Hermes Agent · 火山引擎 Ark</li>
                  <li>DeepSeek · Tailwind CSS 4</li>
                </ul>
              </div>
            </div>
            <div className="border-t border-white/10 mt-8 pt-4 text-center text-xs text-gray-500">
              Built with Hermes Agent · 火山引擎 Ark · DeepSeek
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
