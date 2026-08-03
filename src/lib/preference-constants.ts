/**
 * 共享的偏好选项常量 — build 页和 customers 页共用，保持一致性
 */

export type BuiltinStyle = "auto" | "editorial" | "swiss" | "product-launch" | "xhs-pastel" | "amazon-premium";
export type ModelPref = "auto" | "east-asian" | "european" | "middle-eastern";

export interface StyleOption {
  value: BuiltinStyle;
  label: string;
  desc?: string;
  preview?: string;
  className?: string;
}

export interface ModelOption {
  value: ModelPref;
  label: string;
  image?: string | null;
}

export const STYLE_OPTIONS: StyleOption[] = [
  { value: "auto", label: "🤖 AI 自动", desc: "Agent 智能选择", preview: "🎨", className: "bg-gray-50" },
  { value: "editorial", label: "📰 Editorial", desc: "暖杂志风", preview: "📰", className: "bg-amber-50" },
  { value: "swiss", label: "⬛ Swiss", desc: "瑞士极简", preview: "⬛", className: "bg-gray-100" },
  { value: "product-launch", label: "🚀 产品发布", desc: "暗底Hero", preview: "🚀", className: "bg-slate-800 text-white" },
  { value: "xhs-pastel", label: "🌸 小红书", desc: "马卡龙风", preview: "🌸", className: "bg-pink-50" },
  { value: "amazon-premium", label: "🅰️ Amazon A+", desc: "原生模版", preview: "🅰️", className: "bg-blue-50" },
];

export const OD_STYLES = [
  // Editorial & Magazine
  { value: "cartesian", label: "Cartesian 安静暖调", category: "编辑/杂志" },
  { value: "soft-editorial", label: "Soft Editorial 柔杂志", category: "编辑/杂志" },
  { value: "editorial-tri-tone", label: "Tri-Tone 三色杂志", category: "编辑/杂志" },
  { value: "taste-editorial", label: "Taste Editorial 品味杂志", category: "编辑/杂志" },
  { value: "white-editorial-xhs", label: "XHS 白底杂志", category: "编辑/杂志" },
  { value: "bold-poster", label: "Bold Poster 大胆海报", category: "编辑/杂志" },
  { value: "broadside", label: "Broadside 双语跨页", category: "编辑/杂志" },
  // Minimal & Structural
  { value: "monochrome", label: "Monochrome 全黑白", category: "极简/结构" },
  { value: "neo-grid-bold", label: "Neo-Grid 新粗野网格", category: "极简/结构" },
  { value: "raw-grid", label: "Raw Grid 原生网格", category: "极简/结构" },
  { value: "block-frame", label: "BlockFrame 色块边框", category: "极简/结构" },
  { value: "taste-brutalist", label: "Brutalist CRT 终端", category: "极简/结构" },
  // Dark & Dramatic
  { value: "pink-script", label: "Pink Script 粉字黑底", category: "暗调/戏剧" },
  { value: "studio", label: "Studio 黑底黄字", category: "暗调/戏剧" },
  { value: "coral", label: "Coral 珊瑚奶油", category: "暗调/戏剧" },
  { value: "signal", label: "Signal 深海军金", category: "暗调/戏剧" },
  { value: "vellum", label: "Vellum 牛皮纸学术", category: "暗调/戏剧" },
  // Warm & Natural
  { value: "grove", label: "Grove 森林绿", category: "暖调/自然" },
  { value: "mat", label: "Mat 鼠尾草绿", category: "暖调/自然" },
  { value: "biennale-yellow", label: "Biennale 日光黄", category: "暖调/自然" },
  { value: "stencil-tablet", label: "Stencil 模板刻印", category: "暖调/自然" },
  { value: "long-table", label: "Long Table 长桌晚宴", category: "暖调/自然" },
  // Playful & Youthful
  { value: "capsule", label: "Capsule 药丸卡片", category: "趣味/年轻" },
  { value: "creative-mode", label: "Creative 多色彩", category: "趣味/年轻" },
  { value: "playful", label: "Playful 暖桃底", category: "趣味/年轻" },
  { value: "daisy-days", label: "Daisy Days 雏菊粉", category: "趣味/年轻" },
  { value: "sakura-chroma", label: "Sakura 樱花虹", category: "趣味/年轻" },
  { value: "retro-zine", label: "Retro Zine 复古志", category: "趣味/年轻" },
  { value: "xhs-pastel-card", label: "XHS 马卡龙卡片", category: "趣味/年轻" },
  // Product Launch
  { value: "product-launch-dark", label: "Product Launch 暗底发布", category: "发布/促销" },
];

export const MODEL_OPTIONS: ModelOption[] = [
  { value: "auto", label: "✨ 智能", image: null },
  { value: "east-asian", label: "东亚", image: "/models/east-asian.jpg" },
  { value: "european", label: "欧美", image: "/models/european.jpg" },
  { value: "middle-eastern", label: "中东", image: "/models/middle-eastern.jpg" },
];
