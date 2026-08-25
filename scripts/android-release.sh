#!/bin/bash
# 把公开 Android Release 的 APK 发布到 daemon 的 data/app/，供手机端「设置 → 检查更新」拉取升级。
#   scripts/android-release.sh --from-github [tag] [发布说明]
# 在生产 checkout 里运行；无论当前 checkout 属于哪个仓库，都只从 whtis/ownward 下载。
# 本地构建只用于开发验证，不能作为手机分发渠道；APK 与 android.json 不进 git。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/data/app"

if [ "${1:-}" = "--from-github" ]; then
  TAG="${2:-}"; NOTES="${3:-}"
  REPO="whtis/ownward"
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
echo "本地 APK 只能用于开发验证；请使用：scripts/android-release.sh --from-github [tag] [发布说明]" >&2
exit 64
