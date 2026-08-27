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

## 安全说明（重要）

本项目所有 `/api/*` 接口由 `src/proxy.ts` 统一做访问控制：

- **默认（未配置 token）**：仅允许 `localhost` / `127.0.0.1` / `::1` 访问 API；
  通过局域网/公网 IP 的 API 请求一律返回 401。本地使用体验与之前完全一致。
- **公网/隧道部署（如 ngrok FRP）必须配置 token**，在 `.env.local` 中同时设置：
  ```bash
  AUTH_TOKEN=你的随机token
  NEXT_PUBLIC_AUTH_TOKEN=你的随机token   # 与上面相同，注入前端请求头
  ```
  配置后，非本机 API 请求必须携带 `Authorization: Bearer <token>`（前端自动附带）；
  `localhost` 访问仍免 token，避免前端漏配时本地功能静默损坏。
- `/api/output/*` 豁免认证：预览 iframe 内的 `<img>` 无法携带 Authorization 头；
  该端点经路径校验后只能读取 `~/Downloads/aplus-builder/` 下的产出文件，不含敏感数据。

其他安全加固（2025-08 安全修复）：
- 客户 ID / 上传文件名 / 历史目录名全部做路径穿越校验（`customer-store.ts`、各 route）
- 上传图片仅接受 PNG/JPEG/WebP 且 ≤15MB，按文件头（magic bytes）校验，不信任客户端 MIME
- 预览 iframe 加 `sandbox`，生成的 HTML 无法访问应用同源数据（防存储型 XSS）
- 所有 API 响应附带 `X-Content-Type-Options: nosniff`

## 稳定性保护（对外开放 P0+P1）

对外公开前必须启用的成本/稳定性护栏（环境变量，默认值已兼容本地单用户）：

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `AUTH_USERS` | 空 | 多用户注册表种子（JSON 数组，见下） |
| `AUTH_TOKEN` / `NEXT_PUBLIC_AUTH_TOKEN` | 空 | 旧版单 token 认证（等价 admin） |
| `MAX_DAILY_TASKS` | 200 | 每日任务配额（成本熔断，耗尽返回 429） |
| `MAX_MONTHLY_TASKS` | 2000 | 每月任务配额 |
| `RATE_LIMIT_PER_MINUTE` | 30 | 昂贵写接口（生成/风格复刻/截图）每分钟限次 |
| `MAX_QUEUE` | 20 | 生成任务排队上限（满返回 429） |
| `MAX_AGENT_ATTEMPTS` | 2 | Agent 失败自动重试上限（含首次） |
| `MAX_STYLE_CONCURRENT` | 2 | 风格复刻并发上限 |
| `MAX_SCREENSHOT_CONCURRENT` | 2 | Chrome 截图并发上限 |
| `AGENT_SOURCE` | `web` | 设为 `none` 可关闭 agent 联网（`--source web`） |
| `AGENT_TIMEOUT_MINUTES` / `STYLE_TIMEOUT_MINUTES` | 20 / 10 | Agent 超时（超时阶梯第一步：分接口配置） |
| `OUTPUT_BASE` | `~/Downloads/aplus-builder` | 产出根目录 |
| `AGENT_HOME` | 当前用户主目录 | Agent 进程 HOME/cwd |
| `CHROME_PATH` | macOS Chrome | 截图浏览器路径 |

配套能力：
- **任务可取消**：`DELETE /api/generate?taskId=...`（排队任务直接移除，运行中任务终止 Agent），前端「产出中心」队列项有「取消」按钮
- **任务持久化**：任务元数据存 `<项目>/data/tasks.json`（原子写入），服务重启自动恢复；配额计数存 `data/quota.json`
- **多用户隔离（P1）**：`AUTH_USERS='[{"id":"alice","name":"Alice","token":"tk_xxx"},...]'` 定义用户；各用户 Bearer token 经 proxy 解析后，客户档案/产出/历史按用户隔离存储：
  - `admin`（本机访问/旧 AUTH_TOKEN）→ 沿用旧布局 `customers/`、`~/Downloads/aplus-builder/`
  - 其他用户 → `~/Downloads/aplus-builder/<userId>/...`（含 `customers/` 子目录）
  - 用户注册表落盘 `data/users.json`，可手动增删用户
- **审计日志（P1）**：关键操作（任务创建/完成/取消、客户增删改、上传）追加写入 `data/audit.log`（JSONL）
- **Chrome 截图异步化（P1）**：截图改为异步 spawn + 并发池，不再阻塞事件循环
- **内容审核（合规待办）**：当前未接入外部内容审核服务，公开运营前需自行接入（生成内容含模特图，涉及肖像/版权合规）

> 已知限制：`/api/output`（预览图片加载）对 iframe 免认证，非 admin 用户的历史预览图需后续引入 cookie 会话才能按用户隔离加载。

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
