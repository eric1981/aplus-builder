#!/bin/bash
# aplus-builder 启动脚本（在你自己的终端运行，不依赖任何代理会话）
#
# 用法：
#   ./start-server.sh              启动默认主题（aplus-builder，直接用现有 .next）
#   ./start-server.sh tuduoduo     构建并启动"图多多"客户主题
#   ./start-server.sh <任意客户id> 构建并启动对应客户主题（见 src/lib/brand.ts CUSTOMER_THEMES）
#
# 特性：崩溃自动重启、端口冲突检测（忽略 WhatsApp bridge 的 127.0.0.1 占用）、
#       日志写入 server.log；带客户参数时自动先 build（NEXT_PUBLIC_ 需构建期内联）
#
# 注意：macOS 自带 bash 3.2 对"多字节中文紧跟 $变量"有解析 bug（set -u 下报 unbound），
# 因此本脚本所有变量一律使用 ${VAR} 花括号写法。
set -u
cd "$(dirname "$0")" || exit 1

CUSTOMER="${1:-}"
PORT="${PORT:-3000}"

# 端口检测：尝试绑定通配端口。仅当 *:$PORT 被真占用（如应用已运行）时才阻止；
# WhatsApp bridge 占 127.0.0.1:$PORT 不影响应用绑定 *:$PORT，两者可共存。
if ! python3 -c "import socket; s=socket.socket(); s.bind(('0.0.0.0', ${PORT})); s.close()" 2>/dev/null; then
  echo "端口 ${PORT} 的通配绑定被占用（可能应用已在运行）："
  lsof -nP -iTCP:"${PORT}" | grep LISTEN
  echo "请先停止旧实例再启动。"
  exit 1
fi

# 带客户参数：先构建该客户主题（NEXT_PUBLIC_CUSTOMER_ID 在构建时内联进 JS）
if [ -n "${CUSTOMER}" ]; then
  echo "=== 构建客户主题：${CUSTOMER} ==="
  CUSTOMER_ID="${CUSTOMER}" NEXT_PUBLIC_CUSTOMER_ID="${CUSTOMER}" npm run build
  if [ $? -ne 0 ]; then
    echo "构建失败，请检查 brand.ts 中是否配置了该客户（CUSTOMER_THEMES）。"
    exit 1
  fi
else
  echo "=== 使用现有构建（默认主题 aplus-builder）==="
fi

echo "=== aplus-builder 启动脚本（端口 ${PORT}，Ctrl+C 停止，日志 server.log）==="
while true; do
  echo "[$(date '+%F %T')] 启动 next start -p ${PORT} ..."
  npx next start -p "${PORT}" >> server.log 2>&1
  code=$?
  echo "[$(date '+%F %T')] 服务退出（code=${code}），3 秒后自动重启"
  sleep 3
done
