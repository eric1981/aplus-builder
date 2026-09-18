#!/usr/bin/env bash
# ============================================================================
# aplus-builder 华为云 ECS 环境安装脚本（Ubuntu 22.04 / 24.04，x86_64 或 arm64）
#
# 作用：把「跑起来所需的系统依赖」一次装齐（幂等，可重复执行）：
#   Node 24 / Google Chrome（截图）/ 中文字体（截图不出方块）/ ImageMagick（缩略图兜底）
#   Python 依赖（技能脚本用）/ Nginx / 运行用户 aplus / 目录 / 时区
#
# 用法（在 ECS 上，root 或 sudo）：
#   sudo bash deploy/install-linux.sh
#
# 之后按 deploy/README.md 继续：放代码 → 配 .env.local → 迁移 hermes 与技能 → 起服务
# ============================================================================
set -euo pipefail

APP_USER="${APP_USER:-aplus}"
APP_DIR="${APP_DIR:-/srv/aplus-builder}"
DATA_DIR="${DATA_DIR:-/data/aplus-builder}"     # OUTPUT_BASE（产出 + 数据库）
HOME_DIR="/home/${APP_USER}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 或 sudo 运行"; exit 1
fi

ARCH="$(uname -m)"
log "系统: $(. /etc/os-release && echo "$PRETTY_NAME") / 架构: ${ARCH}"

# ---------------------------------------------------------------- 基础软件
log "安装基础软件包"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
# fonts-noto-cjk 必须装：否则 Chrome 截图里的中文会渲染成方块（产出页/模板缩略图全是中文）
apt-get install -y --no-install-recommends \
  curl ca-certificates gnupg git unzip rsync \
  build-essential python3 python3-pip python3-venv \
  imagemagick fonts-noto-cjk fonts-noto-color-emoji \
  nginx tzdata

log "设置时区 Asia/Shanghai"
ln -snf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime
echo "Asia/Shanghai" > /etc/timezone

# ---------------------------------------------------------------- Node 24
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/^v//;s/\..*//')" -lt 22 ]; then
  log "安装 Node.js 24（node:sqlite 需要 ≥22.5，本项目按 24 开发）"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
else
  log "已存在 Node $(node -v)，跳过"
fi

# ---------------------------------------------------------------- Chrome
# 用途：/api/capture-gallery 画廊样张 + 模板缩略图（lib/screenshot.ts）
if ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
  log "安装 Google Chrome（headless 截图）"
  if [ "${ARCH}" = "x86_64" ]; then
    tmpdeb="$(mktemp -d)/chrome.deb"
    if curl -fsSL -o "${tmpdeb}" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; then
      apt-get install -y "${tmpdeb}" || apt-get install -y -f
    else
      warn "Chrome 下载失败；可改用 apt install chromium-browser（记得设 CHROME_PATH）"
    fi
  else
    warn "非 x86_64：请自行安装 chromium 并把 CHROME_PATH 指向其可执行文件"
  fi
else
  log "已存在 Chrome/Chromium，跳过"
fi

# ---------------------------------------------------------------- 运行用户与目录
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  log "创建运行用户 ${APP_USER}"
  useradd -m -s /bin/bash "${APP_USER}"
fi
log "创建目录：${APP_DIR}（代码）/ ${DATA_DIR}（产出与数据库）/ ${HOME_DIR}/.hermes（agent）"
mkdir -p "${APP_DIR}" "${DATA_DIR}" "${HOME_DIR}/.hermes" "${HOME_DIR}/.local/bin"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}" "${DATA_DIR}" "${HOME_DIR}"

# 数据盘提示：OUTPUT_BASE 指向数据盘（EVS），系统盘只放代码与运行时
warn "请确认 ${DATA_DIR} 位于数据盘（EVS）上：df -h ${DATA_DIR}"

# ---------------------------------------------------------------- Python 依赖（技能脚本）
log "安装技能脚本的 Python 依赖（PIL / numpy / requests / oss2 / 火山 SDK）"
# Ubuntu 24 的 PEP668：系统 python 需 --break-system-packages（专用服务器可接受）
pip3 install --break-system-packages -q --upgrade pip || true
pip3 install --break-system-packages -q \
  pillow numpy requests oss2 volcenginesdkcore \
  || warn "部分 Python 包安装失败，请手动确认（技能换装/生图脚本依赖它们）"

# ---------------------------------------------------------------- hermes（agent 运行时）
log "检查 hermes agent 运行时"
if [ -d "${HOME_DIR}/.hermes/hermes-agent" ]; then
  echo "  已存在 ${HOME_DIR}/.hermes/hermes-agent（如需安装依赖见下方提示）"
else
  warn "未发现 ${HOME_DIR}/.hermes/hermes-agent —— 请从你的 Mac 拷贝源码（不要拷 venv/）："
  cat <<'TIP'
      rsync -av --exclude 'venv' --exclude '__pycache__' --exclude '.git' \
        ~/.hermes/hermes-agent/ root@<ECS-IP>:/home/aplus/.hermes/hermes-agent/
TIP
fi
cat <<'TIP'

  安装 hermes 依赖（以 aplus 用户执行）：
      su - aplus
      curl -LsSf https://astral.sh/uv/install.sh | sh          # 安装 uv（若未安装）
      cd ~/.hermes/hermes-agent
      uv venv venv --python 3.12 && uv pip install -e ".[all,dev]"
      ln -sf ~/.hermes/hermes-agent/venv/bin/hermes ~/.local/bin/hermes
      ~/.local/bin/hermes --version                            # 自检

  迁移 duma profile（不要拷 home/ 与 caches，Linux 上需重装 Python 包）：
      rsync -av --exclude 'home' --exclude 'cache' --exclude 'logs' --exclude '*.log' \
        ~/.hermes/profiles/duma/ root@<ECS-IP>:/home/aplus/.hermes/profiles/duma/
TIP

# ---------------------------------------------------------------- 完成
log "系统侧安装完成"
cat <<'NEXT'

下一步（详见 deploy/README.md）：
  1) 放代码到 /srv/aplus-builder（rsync 或 git clone），npm ci && npm run build
  2) cp .env.local.example .env.local 并填写密钥/路径（OUTPUT_BASE=/data/aplus-builder）
  3) 自检缩略图工具链：node scripts/thumb-check.mjs <任一图片>
  4) 安装服务：cp deploy/aplus-builder.service /etc/systemd/system/ && systemctl enable --now aplus-builder
  5) 配 Nginx：cp deploy/nginx.conf.example /etc/nginx/sites-available/aplus-builder && 启用 + certbot 签证书
  6) 安全组只开 80/443；配置 deploy/backup.sh 定时备份
NEXT
