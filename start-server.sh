#!/bin/bash
# aplus-builder 稳定启动脚本（在你自己的终端运行，不依赖任何代理会话）
# 特性：崩溃自动重启、端口冲突检测（忽略 WhatsApp bridge 的 127.0.0.1 占用）、日志写入 server.log
set -u
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-3000}"

# 端口检测：尝试绑定通配端口。仅当 *:$PORT 被真占用（如应用已运行）时才阻止；
# WhatsApp bridge 占 127.0.0.1:$PORT 不影响应用绑定 *:$PORT，两者可共存。
if ! python3 -c "import socket; s=socket.socket(); s.bind(('0.0.0.0', $PORT)); s.close()" 2>/dev/null; then
  echo "⚠️  端口 $PORT 的通配绑定被占用（可能应用已在运行）："
  lsof -nP -iTCP:"$PORT" | grep LISTEN
  echo "请先停止旧实例再启动。"
  exit 1
fi

echo "=== aplus-builder 启动脚本（端口 $PORT，Ctrl+C 停止，日志 server.log）==="
while true; do
  echo "[$(date '+%F %T')] 启动 next start -p $PORT ..."
  npx next start -p "$PORT" >> server.log 2>&1
  code=$?
  echo "[$(date '+%F %T')] 服务退出（code=$code），3 秒后自动重启"
  sleep 3
done
