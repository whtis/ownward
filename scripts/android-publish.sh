#!/bin/bash
# 安卓正式发版：bump 版本 → 提交 → 打附注 tag → push，GitHub Actions（.github/workflows/android-release.yml）
# 接手构建签名 APK 并发到 GitHub Releases；daemon 侧再用 scripts/android-release.sh --from-github 拉取分发。
# 只能在公开仓库 whtis/ownward 的 main 上执行；私有仓只做构建自检，不能产生第二个分发渠道。
#
# 版本规则：
#   package.json、Android versionName 和 iOS OwnwardVersionName 使用同一个 X.Y.Z；
#   versionCode = YYYYMMDDN，仅用于安装包递增；tag = android-v<version>+<versionCode>。
#
# 用法：scripts/android-publish.sh [-n "发布说明"] [--version X.Y.Z] [--no-push] [--dry-run]
#   正式发布始终是 stable Release，不存在 alpha/beta 渠道。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GRADLE="$ROOT/android/app/build.gradle.kts"
NOTES=""; NEW_BASE=""; PUSH=1; DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--notes) NOTES="$2"; shift 2;;
    --version) NEW_BASE="$2"; shift 2;;
    --no-push) PUSH=0; shift;;
    --dry-run) DRY=1; shift;;
    -h|--help) sed -n '2,14p' "$0"; exit 0;;
    *) echo "未知参数 $1（-h 看用法）"; exit 2;;
  esac
done

cd "$ROOT"
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || git remote get-url origin | sed -E 's#.*[:/]([^/]+/[^/]+?)(\.git)?$#\1#')
[ "$REPO" = "whtis/ownward" ] || { echo "正式 Android Release 只从 whtis/ownward 发布；当前仓库是 $REPO"; exit 1; }
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "当前分支 $BRANCH 不是 main；正式 Android 发布只能在 main 上做"; exit 1
fi
if [ -n "$(git status --porcelain)" ] && [ $DRY = 0 ]; then
  echo "工作区不干净，先提交或 stash"; git status --short | head; exit 1
fi
git fetch -q --tags origin

PACKAGE_VERSION=$(python3 - "$ROOT/package.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["version"])
PY
)
[[ "$PACKAGE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "package.json 版本必须是 X.Y.Z：$PACKAGE_VERSION"; exit 1; }
CUR_NAME=$(grep -o 'versionName = "[^"]*"' "$GRADLE" | cut -d'"' -f2)
CUR_CODE=$(grep -o 'versionCode = [0-9]*' "$GRADLE" | grep -o '[0-9]*')
[ -n "$CUR_NAME" ] && [ -n "$CUR_CODE" ] || { echo "读不到 $GRADLE 的版本号"; exit 1; }
[ "$CUR_NAME" = "$PACKAGE_VERSION" ] || { echo "Android versionName ($CUR_NAME) 必须先与 package.json ($PACKAGE_VERSION) 对齐"; exit 1; }

TODAY=$(date +%Y%m%d)
if [ "${CUR_CODE:0:8}" = "$TODAY" ]; then N=$(( ${CUR_CODE:8} + 1 )); else N=1; fi
NEW_CODE="$TODAY$N"

BASE="$PACKAGE_VERSION"
[ -z "$NEW_BASE" ] || [ "$NEW_BASE" = "$BASE" ] || { echo "--version 必须与 package.json ($BASE) 一致：$NEW_BASE"; exit 1; }
NEW_NAME="$BASE"

TAG="android-v$NEW_NAME+$NEW_CODE"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then echo "tag $TAG 已存在"; exit 1; fi

echo "安卓发版：$CUR_NAME ($CUR_CODE) → $NEW_NAME ($NEW_CODE)   tag $TAG   分支 $BRANCH"
[ -n "$NOTES" ] && echo "说明：$NOTES"
if [ $DRY = 1 ]; then echo "(dry-run，未改文件)"; exit 0; fi

perl -pi -e "s/versionCode = \\d+/versionCode = $NEW_CODE/; s/versionName = \"[^\"]*\"/versionName = \"$NEW_NAME\"/" "$GRADLE"
grep -q "versionCode = $NEW_CODE" "$GRADLE" && grep -q "versionName = \"$NEW_NAME\"" "$GRADLE" || { echo "改写 $GRADLE 失败"; git checkout -- "$GRADLE"; exit 1; }

git add "$GRADLE"
git commit -q -m "release(android): $NEW_NAME ($NEW_CODE)"
git tag -a "$TAG" -m "${NOTES:-Android $NEW_NAME ($NEW_CODE)}"
echo "已提交并打 tag：$(git rev-parse --short HEAD) $TAG"

if [ $PUSH = 1 ]; then
  # 先推分支再推 tag：实测 tag 指向的 commit 不在任何远端分支上时 GitHub 不触发 workflow
  git push -q origin "HEAD:$BRANCH"
  git push -q origin "refs/tags/$TAG"
  echo "已推送；GitHub Actions 构建中：gh run list --workflow android-release.yml -R $REPO"
  echo "发布页：https://github.com/$REPO/releases/tag/${TAG//+/%2B}"
  echo "daemon 分发：scripts/android-release.sh --from-github $TAG"
else
  echo "未推送（--no-push）；手动：git push origin HEAD:$BRANCH refs/tags/$TAG"
fi
