#!/bin/bash
# 标记 iOS 版本发布：把 ios/project.yml 里的版本号写进 daemon 的 data/app/ios.json，
# 供手机端「检查更新」比对 build（YYYYMMDDN）。安装包本身走 TestFlight / Xcode 真机安装，
# 这里只记录版本与安装页链接（第二个参数），不生成 ipa。
# 用法：scripts/ios-release.sh [发布说明] [安装页 URL]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NOTES="${1:-}"
URL="${2:-}"
YML="$ROOT/ios/project.yml"
VERSION_NAME=$(grep -o 'OwnwardVersionName: "[^"]*"' "$YML" | cut -d'"' -f2)
VERSION_CODE=$(grep -o 'CURRENT_PROJECT_VERSION: "[0-9]*"' "$YML" | grep -o '[0-9]*')
[ -n "$VERSION_NAME" ] && [ -n "$VERSION_CODE" ] || { echo "读不到 ios/project.yml 的版本号"; exit 1; }
mkdir -p "$ROOT/data/app"
python3 - "$VERSION_NAME" "$VERSION_CODE" "$NOTES" "$URL" > "$ROOT/data/app/ios.json" <<'PY'
import json, sys
d = {"ok": True, "versionName": sys.argv[1], "versionCode": int(sys.argv[2]), "notes": sys.argv[3]}
if sys.argv[4]: d["url"] = sys.argv[4]
print(json.dumps(d, ensure_ascii=False))
PY
echo "已标记 iOS $VERSION_NAME ($VERSION_CODE) -> data/app/ios.json"
