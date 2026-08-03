# aplus-builder

Amazon A+ 电商详情页 AI 生成器，基于 Next.js 16 + Hermes Agent。

用户上传产品图 → Agent 分析产品属性 → 并行生图 → 自动排版 → 输出 A+ 详情页 HTML（含 2 个风格变体）。

## 架构

```
浏览器 (/build)                      Next.js API Route                   Hermes Agent (duma)
┌──────────────────┐    POST     ┌──────────────────────┐    spawn     ┌────────────────────────┐
│ 产品图 + 偏好    │ ──────────→ │ route.ts              │ ──────────→ │ ecommerce-aplus-detail  │
│ 轮询状态         │ ←─ GET ──── │ 拼 prompt → 写 run.sh │ ←─ exit ─── │ 分析 → 生图 → 排版      │
│ 预览 + 下载      │             │ collectAndFinish      │             │ → index.html + 变体     │
└──────────────────┘             └──────────────────────┘             └────────────────────────┘
                                         │
                                         ▼
                              ~/Downloads/aplus-builder/<产品名>/
```

- **前端**: `~/aplus-builder/` — Next.js 16, React 19, Tailwind CSS 4, TypeScript
- **Agent**: `hermes -p duma -s ecommerce-aplus-detail chat` — 分析图片、并行生图、排版 HTML
- **部署**: `npm run build && npx next start -p 3000`，ngrok FRP 公网 → `cherry.sa1.tunnelfrp.com`

## 快速启动

```bash
cd ~/aplus-builder
npm run build          # 构建
npx next start -p 3000 # 启动（production 模式，ngrok 不支持 WS 所以不能用 dev）
```

访问 `http://localhost:3000`，首页点「✨ 开始使用」进入生成页。

## 功能

### 生成模式
- **详情页模式**（默认）：生成完整 A+ 详情页 + 多场景图 + 白底主图 + 3 个风格变体
- **单图模式**：只生成 1 张场景图

### 批量队列
- 填一个产品 → 加入队列 → 继续填下一个 → 后台 2 并发逐个处理
- 横向滚动队列卡片，实时状态：⏳排队 / 🔵生成中 / ✅完成 / ❌失败

### 客户档案系统
- `/customers` 页面管理客户：名称、Logo、模特图、默认偏好、尺码表、特殊要求
- `/build` 页 Header 下拉选择客户 → 自动加载客户数据并注入 prompt

### 偏好学习
- 三级优先级：用户选择 > 画像推断 > AI 自决
- 每次生成后提取偏好信号，压缩后注入下次 prompt

### 多版本变体
- 一次生成产出 3 个 HTML（主输出 + 2 个风格变体），同一套图片，不同排版

### 历史 & 下载
- IndexedDB 30 天保留，点击恢复预览
- 下载：单张图片 / 单 HTML / ZIP 打包

### 并发 & 持久化
- 最多 2 个 Agent 并行，超额排队
- `/tmp/ecommerce-tasks.json` 持久化，服务器重启自动恢复

## 输入项

| 输入 | 必填 | 说明 |
|------|------|------|
| 产品图 | ✅ | JPG/PNG，模特穿版或平铺 |
| 产品名称 | 否 | 输出目录优先用此命名 |
| 产品描述 | 否 | 不填由 Agent 看图分析 |
| 模特参考图 | 否 | 上传激活火山引擎 dressing API 虚拟换装 |
| 品牌 Logo | 否 | PNG 透明底最佳 |
| 风格偏好 | 否 | 6 种内置 + 14 种 Open Design |

## 关键约束

- **SunnyNgrok 不支持 WebSocket** → 只能用 `next start`（production），不能用 `next dev`
- **改代码必须重建重启** — route.ts 改动不会热更新
- **服务器重启时如果正在生成 → 任务丢失**（虽然 TaskStore 会恢复，但 Agent 进程会重启从头跑）

## 项目结构

```
src/
├── app/
│   ├── page.tsx                 # 首页（landing + 模板画廊）
│   ├── build/page.tsx           # 生成页（表单 + 队列 + 预览）
│   ├── customers/page.tsx       # 客户管理页
│   └── api/
│       ├── generate/
│       │   ├── route.ts         # 核心 API（启动 agent / 轮询 / 收集产出）
│       │   └── task-store.ts    # 任务持久化
│       ├── customers/route.ts   # 客户 CRUD
│       ├── customers/assets/route.ts   # 客户图片资产
│       └── customers/upload/route.ts   # 客户图片上传
├── lib/
│   ├── history.ts               # IndexedDB 历史记录
│   ├── customer-store.ts        # 客户档案抽象层
│   └── preference-constants.ts  # 共享偏好常量
└── public/gallery/              # 模板画廊截图
```

## 相关文档

- 完整流水线：Obsidian `01-Projects/A+电商流水线/完整流水线.md`
- Agent 技能：`~/.hermes/profiles/duma/skills/marketing/ecommerce-aplus-detail/SKILL.md` (v33)
- 前端开发指南：`~/.hermes/skills/software-development/aplus-builder-dev/SKILL.md`
