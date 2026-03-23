#!/bin/bash
# BTC 监测系统 - 定时任务安装脚本
# 使用方式: bash btc-cron-setup.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/btc-check.js"
LOG="$SCRIPT_DIR/btc-alert.log"
CRON_LOG="$SCRIPT_DIR/btc-cron.log"

echo "=============================="
echo "  BTC 监测系统 - 定时任务安装"
echo "=============================="
echo ""

# 检查 node
if ! command -v node &>/dev/null; then
    echo "❌ 未找到 Node.js，请先安装: https://nodejs.org"
    exit 1
fi
echo "✅ Node.js $(node --version)"

# 测试脚本是否能正常运行
echo ""
echo "📡 测试数据抓取..."
node "$SCRIPT" 5m
if [ $? -ne 0 ]; then
    echo "❌ 脚本运行失败，请检查网络连接"
    exit 1
fi

# 安装 cron（每30分钟）
CRON_ENTRY="*/30 * * * * node $SCRIPT 5m >> $CRON_LOG 2>&1"

echo ""
echo "⏰ 安装 cron 定时任务（每30分钟）..."

# 检查是否已存在
(crontab -l 2>/dev/null | grep -q "btc-check.js") && {
    echo "⚠️  已存在 btc-check.js 的 cron 任务，跳过安装"
} || {
    (crontab -l 2>/dev/null; echo "$CRON_ENTRY") | crontab -
    echo "✅ cron 任务已添加"
}

echo ""
echo "📋 当前 cron 配置:"
crontab -l | grep btc

echo ""
echo "📁 日志文件: $CRON_LOG"
echo "📁 数据日志: $LOG"
echo ""
echo "常用命令:"
echo "  查看实时日志:  tail -f $CRON_LOG"
echo "  立即执行一次:  node $SCRIPT 5m"
echo "  使用1小时线:   node $SCRIPT 1h"
echo "  删除定时任务:  crontab -l | grep -v btc-check | crontab -"
