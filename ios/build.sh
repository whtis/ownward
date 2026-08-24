#!/bin/bash
# Ownward iOS：XcodeGen 生成工程 + 模拟器构建/测试/安装。
# 用法：./build.sh            生成工程并 Debug 构建（模拟器）
#      ./build.sh --test     构建并跑单元测试
#      ./build.sh --run      构建、装到 iPhone 17 Pro 模拟器并启动
#      ./build.sh --open     只生成工程并用 Xcode 打开（真机签名/归档在 Xcode 里做）
set -euo pipefail
cd "$(dirname "$0")"
SIM_NAME="${OWNWARD_SIM:-iPhone 17 Pro}"
DEST="platform=iOS Simulator,name=$SIM_NAME"
[ -f Signing.xcconfig ] || cp Signing.xcconfig.example Signing.xcconfig
command -v xcodegen >/dev/null || { echo "缺 xcodegen：brew install xcodegen"; exit 1; }
xcodegen generate --quiet
case "${1:-}" in
  --open) open Ownward.xcodeproj; exit 0 ;;
  --test)
    xcodebuild -project Ownward.xcodeproj -scheme Ownward -destination "$DEST" \
      -derivedDataPath build/DerivedData test 2>&1 | tail -40; exit "${PIPESTATUS[0]}" ;;
  --run)
    xcodebuild -project Ownward.xcodeproj -scheme Ownward -destination "$DEST" \
      -derivedDataPath build/DerivedData -configuration Debug build 2>&1 | tail -5
    APP=build/DerivedData/Build/Products/Debug-iphonesimulator/Ownward.app
    DEV=$(xcrun simctl list devices available | grep "$SIM_NAME (" | head -1 | grep -oE '[0-9A-F-]{36}')
    xcrun simctl bootstatus "$DEV" -b >/dev/null 2>&1 || xcrun simctl boot "$DEV" 2>/dev/null || true
    open -a Simulator
    xcrun simctl install "$DEV" "$APP"
    xcrun simctl launch "$DEV" ai.ownward.app
    echo "✅ launched on $SIM_NAME" ;;
  *)
    xcodebuild -project Ownward.xcodeproj -scheme Ownward -destination "$DEST" \
      -derivedDataPath build/DerivedData -configuration Debug build 2>&1 | tail -5; exit "${PIPESTATUS[0]}" ;;
esac
