#!/bin/bash
# aplus-builder 稳定启动脚本（在你自己的终端运行，不依赖任何代理会话）
# 特性：崩溃自动重启、端口占用自动检测、日志写入 server.log
set -u
cd "$(dirname "$0")" || exit 1

if [ -n "$(lsof -ti:3000 2>/dev/null)" ]; then
  echo "⚠️  端口 3000 已被占用："
  lsof -nP -iTCP:3000 | grep LISTEN
  echo "请先停止占用进程（或改用其他端口：PORT=3001 ./start-server.sh）"
  exit 1
fi

PORT="${PORT:-3000}"
echo "=== aplus-builder 启动脚本（端口 $PORT，Ctrl+C 停止）==="
while true; do
  echo "[$(date '+%F %T')] 启动 next start -p $PORT ..."
  npx next start -p "$PORT" >> server.log 2>&1
  code=$?
  echo "[$(date '+%F %T')] 服务退出（code=$code），3 秒后自动重启"
  sleep 3
done
