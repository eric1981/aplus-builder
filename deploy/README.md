# 部署到华为云 ECS（Linux）操作手册

> 面向：把 aplus-builder + duma agent 从 macOS 迁到华为云 ECS。
> 本目录的脚本都**未经生产验证**，请在测试实例上先跑一遍；所有步骤尽量幂等且不做破坏性操作。

## 0. 选型（结论）

| 档位 | 适用 | 配置 |
|---|---|---|
| 起步 | 1–2 并发、内测 | 通用型 **s7，4 vCPU 8 GiB，x86_64**；系统盘 ESSD 60 GB + 数据盘 ESSD 100 GB |
| **推荐生产** | 3–6 并发 | 通用型 **s7，8 vCPU 16 GiB**；系统盘 60 GB + 数据盘 ESSD 200 GB(PL1) |
| 增长 | 10+ 并发 | s7 16 vCPU 32 GiB；数据盘 300 GB+ |

- **不需要 GPU**：生图/换装走外部 API（火山 Ark / 硅基 / GPT-Image-2）。
- 带宽：产出预览是**内联 base64**（图 2–4MB → +33%），建议 **EIP 按流量计费**或 10 Mbps 起。
- 实例族：`s7` 性价比最好；先在 **x86_64** 上跑通（鲲鹏 ARM 更便宜，但 Chrome/字体/pip wheel 需另行验证）。
- 其它：EIP、EVS 数据盘、OBS（备份/归档）、CES 监控告警；安全组**只放 80/443**。
- 域名：大陆节点需**备案**；纯内测可先用香港/新加坡节点免备案。

## 1. 挂载数据盘（产出与数据库放数据盘）

```bash
lsblk                                  # 找到数据盘，如 /dev/vdb
mkfs.ext4 /dev/vdb                     # 仅首次！确认盘上没有数据
mkdir -p /data && mount /dev/vdb /data
echo '/dev/vdb /data ext4 defaults 0 0' >> /etc/fstab && mount -a
mkdir -p /data/aplus-builder /data/backups
```

## 2. 安装系统依赖

```bash
sudo bash deploy/install-linux.sh
```

装齐：Node 24、Google Chrome（截图）、**fonts-noto-cjk（中文截图必须，否则字变方块）**、
ImageMagick（缩略图兜底）、Python 依赖（PIL/numpy/requests/oss2/volcenginesdkcore）、Nginx、时区。
脚本末尾会打印 hermes 与 profile 的迁移命令。

## 3. 放代码并构建

```bash
# 在 Mac 上推送（排除构建产物与依赖）
rsync -av --exclude node_modules --exclude .next --exclude data --exclude .env.local \
  ~/aplus-builder/ root@<ECS-IP>:/srv/aplus-builder/

# 在 ECS 上
cd /srv/aplus-builder
npm ci                 # 会装上 sharp（缩略图首选，跨平台）
npm run build
```

## 4. 配置环境变量

```bash
cp .env.local.example .env.local && chmod 600 .env.local && vi .env.local
```

必填/注意：
- `OUTPUT_BASE=/data/aplus-builder`（数据盘）
- `AGENT_HOME=/home/aplus`、`HERMES_BIN=/home/aplus/.local/bin/hermes`
- `CHROME_PATH=/usr/bin/google-chrome`
- `TRUSTED_PROXY_HOPS=1`（Nginx 单层反代；限流才会按真实客户端 IP 计数）
- `TRUST_LOCALHOST=false`（生产必须关闭；即使开启也还需 `ALLOW_LOCALHOST_ADMIN=1` 才生效）
- `PAYMENT_WEBHOOK_SECRET`（接微信/支付宝时必填；不填则回调接口返回 503）
- `ADMIN_PASSWORD`（首次启动会创建/校正管理员）

## 5. 迁移 hermes 与 duma 技能

> 关键：保持 `~/.hermes/...` 布局不变（技能里大量用 `~/.hermes/profiles/duma/.env` 等路径），
> 因此把运行用户 `aplus` 的 HOME 作为迁移目标，**不要拷 venv/ 与 home/**（平台相关，需在 Linux 重装）。

```bash
# Mac → ECS：hermes 源码（不含 venv）
rsync -av --exclude venv --exclude __pycache__ --exclude .git \
  ~/.hermes/hermes-agent/ root@<ECS-IP>:/home/aplus/.hermes/hermes-agent/

# Mac → ECS：duma profile（不含平台相关目录）
rsync -av --exclude home --exclude cache --exclude logs --exclude '*.log' \
  ~/.hermes/profiles/duma/ root@<ECS-IP>:/home/aplus/.hermes/profiles/duma/

# ECS 上安装 hermes（以 aplus 用户）
su - aplus
curl -LsSf https://astral.sh/uv/install.sh | sh
cd ~/.hermes/hermes-agent
uv venv venv --python 3.12 && uv pip install -e ".[all,dev]"
ln -sf ~/.hermes/hermes-agent/venv/bin/hermes ~/.local/bin/hermes
~/.local/bin/hermes --version
```

技能脚本的 Python 依赖已由 `install-linux.sh` 装好（`PIL/numpy/requests/oss2/volcenginesdkcore`）。
技能自带 `.env`（VOLC/OSS/GPTIMG2 密钥）随 profile 一起拷过来了，注意权限：`chmod 600`。

## 6. 启动服务与反代

```bash
sudo cp deploy/aplus-builder.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now aplus-builder
systemctl status aplus-builder --no-pager
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login   # 期望 200

sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/aplus-builder
sudo ln -sf /etc/nginx/sites-available/aplus-builder /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com        # 自动签证书并加 HTTPS 跳转
```

## 7. 部署后自检清单

```bash
# ① 缩略图工具链（预览提速的关键）
node scripts/thumb-check.mjs /data/aplus-builder/<某任务>/output/<某图>.jpg

# ② 端到端自测（临时库，不动生产数据）
npm run selftest

# ③ 关键安全行为（都应 401）
curl -s -o /dev/null -w '匿名读产出: %{http_code}\n' https://your-domain.com/api/output/<任意路径>

# ④ 中文字体（截图不出方块）：从后台「订单/充值」页右上没有入口，
#    用产出页「📸 画廊」按钮（仅管理员）重建样张，然后看 /gallery/<name>.png 中文是否正常

# ⑤ agent 能否真跑通：新建一个「单图」任务（1 积分），观察 /output 进度与 agent.log
tail -f /data/aplus-builder/<任务目录>/agent.log
```

## 8. 备份与运维

```bash
# 每日 03:30 备份（SQLite 一致性备份 + 模板 + 配置，保留 14 份）
( crontab -l 2>/dev/null; echo '30 3 * * * /srv/aplus-builder/deploy/backup.sh >> /var/log/aplus-backup.log 2>&1' ) | crontab -
```

- 产出图片是磁盘增长主因（约 **26 MB/任务**）：建议按月 `rsync` 到 OBS 后清理 `/data/aplus-builder`。
- CES 告警建议：CPU > 80%、内存 > 85%、磁盘 > 80%、服务存活。
- 日志：应用 `/var/log/aplus-builder.log`；agent 在各任务目录 `agent.log`；hermes 在 `~/.hermes/profiles/duma/logs/`。

## 9. 已知限制与后续

- **单实例假设**：任务队列、限流在内存，数据在单个 SQLite 文件 → **不能靠加机器横向扩容**；先纵向扩容（加 vCPU/内存）。要多实例需先把队列与限流挪到 Redis/DB。
- **agent 隔离（H9）**：当前 agent 以 `aplus` 用户身份运行（`--yolo`），与宿主机同权限。云端建议用容器隔离（只挂该任务 workDir + 出网白名单）；hermes 自带 Dockerfile，可据此做镜像（需含 Chrome、中文字体、Python 依赖）。
- **macOS 专有依赖**已处理：预览缩略图改用 sharp（→ ImageMagick → sips 回退），不再依赖 `sips`。
