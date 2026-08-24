#!/bin/bash
# 把安卓 APK 发布到 daemon 的 data/app/，供手机端「设置 → 检查更新」拉取升级。两种来源：
#   scripts/android-release.sh [发布说明]              本机构建（签名取 ~/.ownward/android-signing.properties，缺失回落 debug 签名）
#   scripts/android-release.sh --from-github [tag] [发布说明]
#                                                       取 GitHub Release 的签名 APK（默认最新的 android-v* release；
#                                                       由 scripts/android-publish.sh + GitHub Actions 产出，与手机上已装版本同签名）
# 在要发布的 checkout（通常是生产 main）里跑；APK 与 android.json 不进 git。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/data/app"

if [ "${1:-}" = "--from-github" ]; then
  TAG="${2:-}"; NOTES="${3:-}"
  REPO=$(cd "$ROOT" && gh repo view --json nameWithOwner -q .nameWithOwner)
  if [ -z "$TAG" ]; then
    TAG=$(gh api "repos/$REPO/releases?per_page=50" --jq '[.[] | select(.draft|not) | select(.tag_name|startswith("android-v"))][0].tag_name // empty')
    [ -n "$TAG" ] || { echo "GitHub 上还没有 android-v* release"; exit 1; }
  fi
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  gh release download "$TAG" -R "$REPO" -D "$TMP" -p '*.apk' -p android.json -p SHA256SUMS
  APK=$(ls "$TMP"/*.apk | head -1)
  [ -f "$APK" ] && [ -f "$TMP/android.json" ] || { echo "release $TAG 缺 APK 或 android.json"; exit 1; }
  (cd "$TMP" && shasum -a 256 -c SHA256SUMS >/dev/null) || { echo "SHA256 校验失败"; exit 1; }
  cp "$APK" "$ROOT/data/app/ownward.apk"
  if [ -n "$NOTES" ]; then
    python3 - "$TMP/android.json" "$NOTES" > "$ROOT/data/app/android.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["notes"] = sys.argv[2]
print(json.dumps(d, ensure_ascii=False))
PY
  else
    cp "$TMP/android.json" "$ROOT/data/app/android.json"
  fi
  echo "已从 GitHub $TAG 发布 $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["versionName"], "(%s)" % d["versionCode"])' "$ROOT/data/app/android.json") -> data/app/ownward.apk ($(du -h "$ROOT/data/app/ownward.apk" | cut -f1))"
  exit 0
fi

NOTES="${1:-}"
cd "$ROOT/android"
./gradlew :app:assembleRelease -q

APK=$(ls app/build/outputs/apk/release/app-release*.apk | head -1)
[ -f "$APK" ] || { echo "找不到 release APK"; exit 1; }

VERSION_NAME=$(grep -o 'versionName = "[^"]*"' app/build.gradle.kts | cut -d'"' -f2)
VERSION_CODE=$(grep -o 'versionCode = [0-9]*' app/build.gradle.kts | grep -o '[0-9]*')

cp "$APK" "$ROOT/data/app/ownward.apk"
python3 - "$VERSION_NAME" "$VERSION_CODE" "$NOTES" > "$ROOT/data/app/android.json" <<'PY'
import json, sys
print(json.dumps({"ok": True, "versionName": sys.argv[1], "versionCode": int(sys.argv[2]), "notes": sys.argv[3]}, ensure_ascii=False))
PY

echo "已发布 $VERSION_NAME ($VERSION_CODE) -> data/app/ownward.apk ($(du -h "$ROOT/data/app/ownward.apk" | cut -f1))"
