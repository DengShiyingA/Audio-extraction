#!/bin/bash

SERVER_IP="38.76.199.94"
SERVER_DIR="/www/wwwroot/audio.dengshiying.com"
GITHUB_REPO="https://github.com/3281341052g-bot/Audio-extraction.git"

echo "=============================="
echo "  Audio Parser 部署脚本"
echo "=============================="

# 1. 推送到 GitHub
echo ""
echo "→ 正在推送到 GitHub..."
git add -A
git diff --cached --quiet && echo "  没有新改动，跳过 commit。" || {
  read -p "  请输入 commit 信息（直接回车使用默认）: " msg
  msg=${msg:-"update"}
  git commit -m "$msg"
}
git push origin main
echo "  ✓ GitHub 同步完成"

# 2. 部署到服务器
echo ""
echo "→ 正在连接服务器并部署..."
ssh root@$SERVER_IP "
  set -e
  cd $SERVER_DIR
  git pull origin main
  npm install --production
  npm run build
  pm2 restart audio-parser
  echo '✓ 服务器部署完成'
"

echo ""
echo "=============================="
echo "  全部完成！"
echo "  网站地址: https://audio.dengshiying.com"
echo "=============================="
