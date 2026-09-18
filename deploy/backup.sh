#!/usr/bin/env bash
# 备份脚本（建议 cron 每日 03:30 执行）：
#   - SQLite 一致性备份（VACUUM INTO，WAL 安全）
#   - customer-templates（复刻模板 HTML）与 .env.local（含密钥，注意权限）
#   - 保留最近 N 份；若装了 obsutil 可再上传到华为云 OBS
#
# 用法：sudo -u aplus bash deploy/backup.sh
#   cron: 30 3 * * * /srv/aplus-builder/deploy/backup.sh >> /var/log/aplus-backup.log 2>&1
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/aplus-builder}"
DATA_DIR="${DATA_DIR:-/data/aplus-builder}"
BACKUP_DIR="${BACKUP_DIR:-/data/backups}"
KEEP="${KEEP:-14}"

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "[$(date '+%F %T')] 开始备份 → ${BACKUP_DIR}"

# 1) SQLite 一致性备份（VACUUM INTO 会等待并生成完整副本，适用于 WAL 模式）
if [ -f "${APP_DIR}/data/app.db" ]; then
  node -e "
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('${APP_DIR}/data/app.db');
    db.exec(\"VACUUM INTO '${BACKUP_DIR}/app-${STAMP}.db'\");
    db.close();
  "
  echo "  ✓ 数据库 → app-${STAMP}.db"
fi

# 2) 模板与配置（配置含密钥，权限收紧）
tar -czf "${BACKUP_DIR}/templates-${STAMP}.tar.gz" -C "${APP_DIR}" customer-templates 2>/dev/null || true
if [ -f "${APP_DIR}/.env.local" ]; then
  install -m 600 "${APP_DIR}/.env.local" "${BACKUP_DIR}/env-${STAMP}.local"
  echo "  ✓ 配置 → env-${STAMP}.local（权限 600）"
fi

# 3) 可选：上传到 OBS（需安装 obsutil 并配置 AK/SK）
if command -v obsutil >/dev/null 2>&1 && [ -n "${OBS_BUCKET:-}" ]; then
  obsutil cp "${BACKUP_DIR}/app-${STAMP}.db" "obs://${OBS_BUCKET}/aplus-backup/" -f || true
  echo "  ✓ 已上传 OBS（${OBS_BUCKET}）"
fi

# 4) 清理旧备份
ls -1t "${BACKUP_DIR}"/app-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
ls -1t "${BACKUP_DIR}"/templates-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
ls -1t "${BACKUP_DIR}"/env-*.local 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "[$(date '+%F %T')] 备份完成（保留最近 ${KEEP} 份）"
echo "  提示：产出图片体积最大（约 26MB/任务），建议按月归档到 OBS 后清理 ${DATA_DIR}"
