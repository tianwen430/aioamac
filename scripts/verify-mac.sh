#!/usr/bin/env bash
# Mac 首次打开修复脚本。在“终端”里运行：
#   bash scripts/verify-mac.sh "/Applications/AIOA Workbench.app"
# 作用：清除浏览器下载标记；检查签名；签名不完整时做 ad-hoc 重签。
set -u

APP="${1:-/Applications/AIOA Workbench.app}"

if [ ! -d "$APP" ]; then
  echo "找不到应用：$APP"
  echo "用法：bash scripts/verify-mac.sh \"/Applications/AIOA Workbench.app\""
  exit 1
fi

echo "== 1/3 清除隔离属性 =="
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
echo "已清除（如果没有该属性也不影响）"

echo
echo "== 2/3 检查代码签名 =="
ERR_FILE="$(mktemp -t aioa-codesign)"
if codesign --verify --deep --strict "$APP" 2>"$ERR_FILE"; then
  echo "签名完整。"
else
  echo "签名不完整或缺失，尝试 ad-hoc 重签……"
  cat "$ERR_FILE"
  codesign --force --deep --sign - "$APP"
  codesign --verify --deep --strict "$APP"
  echo "已重签。"
fi
rm -f "$ERR_FILE"

echo
echo "== 3/3 Gatekeeper 评估 =="
spctl --assess --type execute --verbose=4 "$APP" 2>&1 || true

echo
echo "完成。现在双击打开。"
echo "如果仍提示“已损坏/无法验证”："
echo "  系统设置 → 隐私与安全性 → 仍要打开"
echo "  或者重新下载对应芯片的安装包（Apple Silicon 选 arm64，Intel 选 x64）。"
