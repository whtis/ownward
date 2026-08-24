#!/bin/bash
# 安卓发版：bump 版本 → 提交 → 打附注 tag → push，GitHub Actions（.github/workflows/android-release.yml）
# 接手构建签名 APK 并发到 GitHub Releases；daemon 侧再用 scripts/android-release.sh --from-github 拉取分发。
#
# 版本规则：
#   versionCode = YYYYMMDDN（今天 + 当日序号，每次发版自动 +1）
#   versionName = X.Y.Z-alpha.YYYYMMDD / X.Y.Z-beta.YYYYMMDD / X.Y.Z——日期跟着发版日走，X.Y.Z 只在 --version 明确给出时改
#   渠道 alpha → beta → stable：stable 必须已有同版本的 beta tag
#   tag = android-v<versionName>+<versionCode>（workflow 会校验 tag 与代码一致）
#
# 用法：scripts/android-publish.sh [-n "发布说明"] [--channel alpha|beta|stable] [--version X.Y.Z]
#                                  [--allow-branch] [--no-push] [--dry-run]
#   默认只允许在 main 上发；--allow-branch 放行其他分支（流水线自检用）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GRADLE="$ROOT/android/app/build.gradle.kts"
NOTES=""; CHANNEL=""; NEW_BASE=""; ALLOW_BRANCH=0; PUSH=1; DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--notes) NOTES="$2"; shift 2;;
    --channel) CHANNEL="$2"; shift 2;;
    --version) NEW_BASE="$2"; shift 2;;
    --allow-branch) ALLOW_BRANCH=1; shift;;
    --no-push) PUSH=0; shift;;
    --dry-run) DRY=1; shift;;
    -h|--help) sed -n '2,14p' "$0"; exit 0;;
    *) echo "未知参数 $1（-h 看用法）"; exit 2;;
  esac
done

cd "$ROOT"
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ] && [ $ALLOW_BRANCH = 0 ]; then
  echo "当前分支 $BRANCH 不是 main；发版应在 main 上做（自检可加 --allow-branch）"; exit 1
fi
if [ -n "$(git status --porcelain)" ] && [ $DRY = 0 ]; then
  echo "工作区不干净，先提交或 stash"; git status --short | head; exit 1
fi
git fetch -q --tags origin

CUR_NAME=$(grep -o 'versionName = "[^"]*"' "$GRADLE" | cut -d'"' -f2)
CUR_CODE=$(grep -o 'versionCode = [0-9]*' "$GRADLE" | grep -o '[0-9]*')
[ -n "$CUR_NAME" ] && [ -n "$CUR_CODE" ] || { echo "读不到 $GRADLE 的版本号"; exit 1; }

TODAY=$(date +%Y%m%d)
if [ "${CUR_CODE:0:8}" = "$TODAY" ]; then N=$(( ${CUR_CODE:8} + 1 )); else N=1; fi
NEW_CODE="$TODAY$N"

BASE="${CUR_NAME%%-*}"
case "$CUR_NAME" in
  *-alpha.*) CUR_CH=alpha;; *-beta.*) CUR_CH=beta;; *-*) echo "认不出渠道：$CUR_NAME"; exit 1;; *) CUR_CH=stable;;
esac
[ -n "$NEW_BASE" ] && BASE="$NEW_BASE"
[[ "$BASE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "版本号 $BASE 不是 X.Y.Z"; exit 1; }
CH="${CHANNEL:-$CUR_CH}"
case "$CH" in
  alpha) NEW_NAME="$BASE-alpha.$TODAY";;
  beta)  NEW_NAME="$BASE-beta.$TODAY";;
  stable)
    NEW_NAME="$BASE"
    if [ -z "$(git tag -l "android-v$BASE-beta.*")" ]; then
      echo "stable $BASE 必须先有 beta tag（android-v$BASE-beta.*），先 --channel beta 发一版"; exit 1
    fi;;
  *) echo "渠道只能是 alpha|beta|stable：$CH"; exit 1;;
esac
# 渠道只能前进：alpha → beta → stable
rank() { case "$1" in alpha) echo 0;; beta) echo 1;; stable) echo 2;; esac; }
if [ "$BASE" = "${CUR_NAME%%-*}" ] && [ "$(rank "$CH")" -lt "$(rank "$CUR_CH")" ]; then
  echo "渠道不能回退：$CUR_CH → $CH（要回退先 --version 升版本号）"; exit 1
fi

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
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || git remote get-url origin | sed -E 's#.*[:/]([^/]+/[^/]+?)(\.git)?$#\1#')
  echo "已推送；GitHub Actions 构建中：gh run list --workflow android-release.yml -R $REPO"
  echo "发布页：https://github.com/$REPO/releases/tag/${TAG//+/%2B}"
  echo "daemon 分发：scripts/android-release.sh --from-github $TAG"
else
  echo "未推送（--no-push）；手动：git push origin HEAD:$BRANCH refs/tags/$TAG"
fi
