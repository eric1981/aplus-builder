/**
 * 品牌/主题配置（多客户定制化）
 *
 * 每个客户一个主题配置（logo、品牌色、首页文案、页脚文案等），
 * 通过环境变量 CUSTOMER_ID 选择；不设置时使用默认主题（aplus-builder）。
 *
 * 注意：本文件同时被服务端组件（layout/page）与客户端组件（nav）引用，
 * 客户端只能读取 NEXT_PUBLIC_ 前缀的环境变量 —— 因此主题选择只依赖
 * CUSTOMER_ID（服务端注入），页面/组件用它查表即可。
 *
 * 颜色通过 CSS 变量注入：layout.tsx 在 <body> 上覆盖 --accent 等变量，
 * 全局所有 var(--accent) / bg-brand / hover:text-brand 自动跟随主题。
 */

export interface BrandColors {
  /** 主 CTA / logo 高亮色 */
  accent: string;
  /** accent 悬停色（按钮 hover） */
  accentHover: string;
  /** accent 按下色 */
  accentActive: string;
  /** 导航/页脚链接 hover 色 */
  accentLight: string;
  /** 链接蓝 */
  link: string;
}

export interface BrandTheme {
  /** 品牌名（显示用） */
  name: string;
  /** logo 第一部分（高亮色）与第二部分 */
  logoPart1: string;
  logoPart2: string;
  /** 图形 logo（public 路径）；有则首页 hero 上方显示，其余页面仅导航文字 logo */
  logoImage?: string;
  /** 品牌配色（注入 CSS 变量） */
  colors: BrandColors;
  /** 页脚副标题 */
  tagline: string;
  /** 首页 hero */
  hero: {
    badge: string;
    title: string;
    subtitle: string;
    pipeline: string;
    cta: string;
    /** 首屏两侧悬浮模特图（6 张竖版 9:16 图片，public 路径）；空数组则不显示 */
    images?: string[];
  };
  /** 首页三步流程 */
  steps: { step: string; title: string; desc: string }[];
  /** 首页特性 */
  features: { label: string; value: string; sub: string }[];
  /** 横向作品轮播（hero 下方，展示产出场景图）；默认开启 */
  showScroller?: boolean;
  /** 轮播 fallback 图（动态拉取失败时用） */
  scrollerImages?: string[];
  /** 数据成果展示（hero 与轮播之间）；未配置时用组件默认 */
  stats?: {
    title: string;
    items: { value: string; label: string }[];
  };
  /** 核心优势板块；未配置时用组件默认 */
  advantages?: {
    title: string;
    subtitle?: string;
    items: { title: string; desc: string; emoji?: string; image?: string; href?: string }[];
  };
  /** 页脚版权行 */
  copyright: string;
}

/** 默认主题：aplus-builder（亚马逊风格） */
const DEFAULT_THEME: BrandTheme = {
  name: "aplus-builder",
  logoPart1: "aplus",
  logoPart2: "-builder",
  colors: {
    accent: "#ff9900",
    accentHover: "#ffa41c",
    accentActive: "#e8840e",
    accentLight: "#ffb84d",
    link: "#007185",
  },
  tagline: "Amazon A+ 视觉工业流水线：产品图 → AI 生图 → 详情页排版 → 交付",
  hero: {
    badge: "AI 生成 · 一键交付",
    title: "aplus builder 视觉工业流水线",
    subtitle: "上传一张白底产品图，AI 自动完成全流程",
    pipeline: "产品特征分析 → Amazon大卖视觉分析 → 多场景图生成 → A+ 详情页排版 → 一键下载交付",
    cta: "✨ 开始使用",
    // 首屏两侧悬浮图：3 张模特图 + 3 张 gallery 风格图（9:16 竖版）
    images: [
      "/models/east-asian.jpg",
      "/gallery/editorial.png",
      "/models/middle-eastern.jpg",
      "/gallery/swiss.png",
      "/models/european.jpg",
      "/gallery/product-launch.png",
    ],
  },
  steps: [
    { step: "①", title: "上传产品图", desc: "拖拽或点击上传一张白底产品照，支持 JPG/PNG/WebP。可选填产品描述帮助 AI 更准确。" },
    { step: "②", title: "AI 自动生成", desc: "AI 分析产品特征与 Amazon 大卖视觉，生成 5-8 张场景图，再排版成 A+ 详情页。约 2-5 分钟。" },
    { step: "③", title: "下载交付", desc: "预览 A+ 详情页效果，单独下载每张图或一键打包全部。直接上传 Amazon。" },
  ],
  features: [
    { label: "内置风格", value: "5 种", sub: "+14 变体模板" },
    { label: "场景图生成", value: "5-8 张", sub: "AI 图生图" },
    { label: "AI 偏好学习", value: "自动", sub: "越用越懂你" },
    { label: "输出格式", value: "HTML+图", sub: "直接上传 Amazon" },
  ],
  showScroller: true,
  stats: {
    title: "使用 AI 生成模特进行时尚摄影和品牌画册创作的电商品牌，正在取得可量化的成果",
    items: [
      { value: "-90%", label: "视觉制作成本降低" },
      { value: "10x", label: "产品上线速度提升" },
      { value: "+10%", label: "转化率提升" },
      { value: "+12%", label: "客单价提升" },
      { value: "+30%", label: "广告点击率提升" },
    ],
  },
  copyright: "面向 Amazon 卖家的 AI 视觉内容工具",
};

/**
 * 客户主题表：新增客户时在此加一项即可（无需改组件代码）。
 * key 对应 CUSTOMER_ID 环境变量值。
 */
const CUSTOMER_THEMES: Record<string, BrandTheme> = {
  // ─── 客户：图多多 ──────────────────────────────────────────────
  // 导航文字 logo：图（accent 橙）+ 多多（白）；首页 hero 上方放图形 logo
  "tuduoduo": {
    name: "图多多",
    logoPart1: "图",
    logoPart2: "多多",
    logoImage: "/brands/tuduoduo.jpg",
    colors: {
      accent: "#ff9900",
      accentHover: "#ffa41c",
      accentActive: "#e8840e",
      accentLight: "#ffb84d",
      link: "#007185",
    },
    tagline: "图多多视觉流水线：产品图 → AI 生图 → 详情页排版 → 交付",
    hero: {
      badge: "AI 生成 · 一键交付",
      title: "图多多 视觉工业流水线",
      subtitle: "上传一张白底产品图，AI 自动完成全流程",
      pipeline: "产品特征分析 → Amazon大卖视觉分析 → 多场景图生成 → A+ 详情页排版 → 一键下载交付",
      cta: "✨ 开始使用",
      images: [
        "/models/east-asian.jpg",
        "/gallery/editorial.png",
        "/models/middle-eastern.jpg",
        "/gallery/swiss.png",
        "/models/european.jpg",
        "/gallery/product-launch.png",
      ],
    },
    steps: [
      { step: "①", title: "上传产品图", desc: "拖拽或点击上传一张白底产品照，支持 JPG/PNG/WebP。可选填产品描述帮助 AI 更准确。" },
      { step: "②", title: "AI 自动生成", desc: "AI 分析产品特征与 Amazon 大卖视觉，生成 5-8 张场景图，再排版成 A+ 详情页。约 2-5 分钟。" },
      { step: "③", title: "下载交付", desc: "预览 A+ 详情页效果，单独下载每张图或一键打包全部。直接上传 Amazon。" },
    ],
    features: [
      { label: "内置风格", value: "5 种", sub: "+14 变体模板" },
      { label: "场景图生成", value: "5-8 张", sub: "AI 图生图" },
      { label: "AI 偏好学习", value: "自动", sub: "越用越懂你" },
      { label: "输出格式", value: "HTML+图", sub: "直接上传 Amazon" },
    ],
    showScroller: true,
    copyright: "面向 Amazon 卖家的 AI 视觉内容工具",
  },

  // 示例客户 A：换个 logo 与首页标题
  "customer-a": {
    ...DEFAULT_THEME,
    name: "Brand A",
    logoPart1: "Brand",
    logoPart2: "A",
    tagline: "AI 电商视觉流水线：从产品图到上架素材，一步到位",
    hero: {
      badge: "AI 生成 · 一键交付",
      title: "Brand A 电商视觉流水线",
      subtitle: "上传一张产品图，AI 自动完成全流程",
      pipeline: "产品特征分析 → 竞品视觉分析 → 多场景图生成 → 详情页排版 → 一键下载交付",
      cta: "✨ 立即开始",
    },
    copyright: "面向全球卖家的 AI 视觉内容工具",
  },
};

/** 运行时选择的主题（CUSTOMER_ID 环境变量，服务端注入） */
export function getBrandTheme(customerId?: string): BrandTheme {
  const id = customerId || process.env.CUSTOMER_ID || "";
  return CUSTOMER_THEMES[id] || DEFAULT_THEME;
}

/** 服务端组件用：直接读环境变量 */
export function getCurrentBrand(): BrandTheme {
  return getBrandTheme();
}

/** 客户端组件用：只能拿到 NEXT_PUBLIC_CUSTOMER_ID（服务端注入到 bundle） */
export function getClientBrand(): BrandTheme {
  return getBrandTheme(
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_CUSTOMER_ID : undefined,
  );
}

/** 主题配色 → CSS 变量（注入到 <body> style，全局 var() 跟随） */
export function brandCssVars(brand: BrandTheme): Record<string, string> {
  return {
    "--accent": brand.colors.accent,
    "--accent-hover": brand.colors.accentHover,
    "--accent-active": brand.colors.accentActive,
    "--accent-light": brand.colors.accentLight,
    "--link": brand.colors.link,
  };
}
