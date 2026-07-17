import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="zh-CN">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,300..700&family=Noto+Sans+SC:wght@300..700&family=Noto+Serif+SC:wght@300..700&family=Playfair+Display:ital,wght@0,400..700;1,400..700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
