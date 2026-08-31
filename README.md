# aplus-builder

Amazon A+ 电商详情页 AI 生成器，基于 Next.js 16 + Hermes Agent。

用户上传产品图 → Agent 分析产品属性 → 并行生图 → 自动排版 → 输出 A+ 详情页 HTML（含 2 个风格变体），**同时并行给出该款式在 Amazon US 市场的销售潜力预测（含成本核算）**。

## 架构

```
浏览器 (aplus-builder 前端, 亚马逊风格)
   │  HTTP（登录 / 表单 / 展示 / 预测卡片）
   ▼
Next.js API Route ──spawn──► Hermes Agent (duma)
   │  ├─ 生图任务        → ecommerce-aplus-detail skill → 图片 + A+ HTML
   │  └─ 市场分析（并行）→ ecommerce-market-analysis skill → sales-prediction.json
   │                       （联网调研 Amazon US + 成本核算）
   ▼
SQLite (data/app.db) —— 任务/客户/用户/配额/设置/审计
产出目录 (~/Downloads/aplus-builder/) —— 图片与 HTML 交付物（磁盘）
```

- **前端**: Next.js 16, React 19, Tailwind CSS 4, TypeScript；**亚马逊风格 UI**（深藏青导航 + 橙/黄 CTA + 白卡灰边）
- **Agent**: `hermes -p duma -s ecommerce-aplus-detail chat`（生图排版）+ `hermes -p duma -s ecommerce-market-analysis chat`（市场预测）
- **数据**: SQLite（Node 24 内置 `node:sqlite`，零依赖）+ 磁盘媒体文件

## 快速启动

```bash
cd ~/aplus-builder
npm run build                       # 构建
./start-server.sh                   # 稳定启动（崩溃自动重启，日志 server.log）
```

访问 `http://localhost:3000`，登录后进入生成页。（默认**严格登录模式**：所有页面都要求登录。）

首次部署管理员凭据：
```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=你的密码 ./start-server.sh
```
不配置 `ADMIN_PASSWORD` 时自动生成随机密码并打印在启动日志/`server.log` 中。

## 功能

### 生成模式
- **详情页模式**（默认）：完整 A+ 详情页 + 多场景图 + 白底主图 + 风格变体
- **单图模式**：只生成 1 张场景图

### 市场潜力预测（新增）
- 每个生成任务**并行**自动触发市场分析（不依赖生成结果、不占生成队列）
- 联网调研 **Amazon US**：竞品价格、竞争密度、头部评价量级、季节趋势
- 输出（产出页「📈 市场潜力预测」卡片）：
  - 综合评分（0-100）、预估月销区间、建议定价
  - 竞争 / 季节 / 趋势 / 最佳上架季节
  - **成本核算**：预估到岸成本、亚马逊费用（佣金率+FBA）、单件毛利与毛利率
  - 卖点 / 风险 / 机会 + 中文总结
- 需要安装分析 skill（见下「市场预测 Skill」）；并发与超时可在 `/admin` 系统设置调整

### 批量队列
- 填一个产品 → 加入队列 → 后台多并发逐个处理（并发数可配）
- 实时状态：⏳排队 / 🔵生成中 / ✅完成 / ❌失败；运行中可**取消**

### 客户档案系统
- `/customers` 管理客户：名称、Logo、模特图、默认偏好、尺码表、特殊要求
- `/build` 页选择客户 → 自动加载数据注入 prompt

### 偏好学习
- 三级优先级：用户选择 > 画像推断 > AI 自决；偏好信号自动提取注入

### 历史 & 下载
- 历史记录存数据库（`/output` 页直接查库），点击恢复预览（含市场预测）
- 下载：单张图片 / 单 HTML / ZIP 打包

## 用户登录与管理后台

- **登录**：邮箱 + 密码（`node:crypto` scrypt 散列，零依赖），HttpOnly + SameSite=Lax 会话 Cookie（30 天），登录限流防爆破
- **登录模式（默认严格）**：所有页面（含本机 localhost）都要求登录；如需本机免登录开发便利，可在 `/admin`「系统设置」开启 `本机免登录（localhost = admin）`（`TRUST_LOCALHOST=1`）
- **账号来源**：默认**管理员创建**（防滥用，每个账号消耗 LLM 费用）
- **管理后台 `/admin`**：
  - 用户管理：创建 / 禁用 / 改角色 / 重置密码 / 删除 / **每用户配额**（日/月上限）
  - 配额总览、任务统计、**审计日志**（谁在何时做了什么）
  - **系统设置**：全局配额、并发/队列、Agent 联网与超时、上传上限、限流等**即时生效**
- **身份与数据隔离**：会话 Cookie（或 Bearer token）→ proxy 注入 `x-user-id` → 客户/产出/历史按用户隔离；`/api/output` 图片随 Cookie 按用户隔离加载

## 数据存储（SQLite）

元数据全部入库 `data/app.db`（WAL 模式）：
- `tasks`：生成任务（运行时队列 + 历史 + 市场预测 `prediction` 列一体）
- `customers`：客户档案（媒体文件仍在磁盘 `customers/<id>/`）
- `users`：用户（邮箱/密码散列/角色/配额）
- `sessions` / `audit_log` / `quota` / `settings`：会话、审计、配额计数、配置中心

首次启动自动从旧存储（JSON 文件 + 磁盘扫描）幂等迁移；**建议定期备份 `data/app.db`**（复制文件即可，最好连 `-wal`/`-shm` 一起或停机时备份）。

## 配置中心（管理后台「系统设置」，环境变量兜底）

三级取值：**管理后台设置（DB）> 环境变量 > 默认值**，多数改动即时生效：

| 配置项 | 环境变量 | 默认 | 作用 |
|---|---|---|---|
| 每日/每月全局任务配额 | `MAX_DAILY_TASKS` / `MAX_MONTHLY_TASKS` | 200 / 2000 | 成本熔断（耗尽 429） |
| 生图并发 / 排队上限 | `MAX_CONCURRENT` / `MAX_QUEUE` | 2 / 20 | 队列满 429 |
| 失败自动重试上限 | `MAX_AGENT_ATTEMPTS` | 2 | 含首次启动 |
| 风格复刻 / 截图 / 市场分析并发 | `MAX_STYLE_CONCURRENT` / `MAX_SCREENSHOT_CONCURRENT` / `MAX_ANALYSIS_CONCURRENT` | 2 | 各类任务并行度 |
| 昂贵接口限流 | `RATE_LIMIT_PER_MINUTE` | 30 次/分 | 生成/复刻/截图/分析 |
| Agent 联网 | `AGENT_SOURCE` | web | `none` 关闭 `--source web` |
| 生图 / 复刻 / 分析超时 | `AGENT_TIMEOUT_MINUTES` / `STYLE_TIMEOUT_MINUTES` / `ANALYSIS_TIMEOUT_MINUTES` | 20 / 10 / 10 | 分钟 |
| 单文件上传上限 | `MAX_UPLOAD_MB` | 15 | MB |
| 本机免登录 | `TRUST_LOCALHOST` | false | 严格模式默认关 |
| 产出根目录 | `OUTPUT_BASE` | `~/Downloads/aplus-builder` | 部署级，仅环境变量 |
| Agent HOME / Chrome 路径 | `AGENT_HOME` / `CHROME_PATH` | 主目录 / macOS Chrome | 部署级，仅环境变量 |

API 脚本调用（非浏览器）可用 `AUTH_USERS='[{"id":"alice","name":"Alice","token":"tk_xxx"}]'` 提供 Bearer token；旧版 `AUTH_TOKEN` 仍兼容（等价 admin）。

## 安全

- **认证**：proxy 统一鉴权闸；登录限流；会话 Cookie（HttpOnly + SameSite=Lax）
- **路径安全**：客户 ID / 上传文件名 / 历史目录名全部路径穿越校验 + resolved 前缀兜底
- **上传校验**：仅 PNG/JPEG/WebP 且 ≤上限，按 magic bytes 判定，不信任客户端 MIME
- **XSS**：预览 iframe 加 `sandbox`（无 allow-same-origin），生成 HTML 无法访问应用同源数据
- **响应头**：`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`
- **配额与审计**：全局 + 每用户配额双重熔断；关键操作全量审计

> 合规待办：生成内容含模特图，公开运营前建议接入外部内容审核服务（肖像/版权）。

## 市场预测 Skill（需安装）

`skills/ecommerce-market-analysis/SKILL.md`（已入库）需复制到 hermes profile：

```bash
mkdir -p ~/.hermes/profiles/duma/skills/marketing/ecommerce-market-analysis
cp ~/aplus-builder/skills/ecommerce-market-analysis/SKILL.md \
   ~/.hermes/profiles/duma/skills/marketing/ecommerce-market-analysis/SKILL.md
```

## 关键约束

- **改代码必须重建重启**（`npm run build` 后重启 `start-server.sh`）
- **服务器重启时正在生成的任务会从头重跑**（任务元数据会恢复，但 Agent 进程被中断）
- **部署建议**：远程主机需安装 hermes + skills + LLM 凭证（仅服务器进程内），应用与 hermes 均不暴露公网，只开 Web 端口 + HTTPS 反代（Caddy/Cloudflare Tunnel）
- **备份**：`data/app.db` + 产出目录为全部业务数据，定期备份

## 项目结构

```
src/
├── proxy.ts                     # 认证闸门（session/token/localhost → x-user-id）
├── app/
│   ├── layout.tsx               # 亚马逊导航 + 深色页脚
│   ├── page.tsx                 # 首页（landing + 画廊）
│   ├── login/page.tsx           # 登录页
│   ├── admin/page.tsx           # 管理后台（用户/配额/设置/审计）
│   ├── build/output/customers/style-extract/page.tsx
│   └── api/
│       ├── auth/login|logout|me # 认证
│       ├── admin/users|settings|stats|audit
│       ├── generate/            # 核心（队列 + spawn agent + 并行市场分析）
│       ├── customers/           # 客户 CRUD + 资产 + 上传
│       └── list-history / load-output / save-history / style-extract / capture-gallery / output
├── components/AmazonNav.tsx     # 亚马逊风格顶部导航
├── lib/
│   ├── db.ts                    # SQLite 层（schema + 迁移）
│   ├── auth.ts / users.ts / admin.ts   # 认证与用户管理
│   ├── settings.ts              # 配置中心（DB + env 兜底）
│   ├── limits.ts                # 配额（全局+每用户）+ 限流
│   ├── market-analysis.ts       # 市场预测（并行 spawn + 解析）
│   ├── config.ts / customer-store.ts / history.ts / audit.ts
│   └── upload-validate.ts / screenshot.ts / apiFetch.ts / auth-client.ts
├── types/node-sqlite.d.ts       # node:sqlite 类型声明
skills/ecommerce-market-analysis/SKILL.md   # 市场预测 skill（需安装到 hermes）
public/gallery/                  # 画廊截图
data/                            # app.db 等运行时数据（gitignored）
start-server.sh                  # 稳定启动脚本（自动重启）
```

## 相关文档

- 完整流水线：Obsidian `01-Projects/A+电商流水线/完整流水线.md`
- Agent 生图技能：`~/.hermes/profiles/duma/skills/marketing/ecommerce-aplus-detail/SKILL.md`
- Agent 市场分析技能：`~/.hermes/profiles/duma/skills/marketing/ecommerce-market-analysis/SKILL.md`
