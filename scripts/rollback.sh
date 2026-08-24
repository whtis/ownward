#!/bin/bash
# Runtime rollback selects an immutable paired release; it never rewrites the repository worktree.
set -euo pipefail
cd "${OWNWARD_SOURCE_ROOT:-$(dirname "$0")/..}"
if [ "${1:-}" != "--helper" ];then echo "rollback.sh 只能由一次性 launchd helper 执行";exit 64;fi
: "${OWNWARD_BUN:?launchd plist must provide absolute OWNWARD_BUN}"
DATA_ROOT="${OWNWARD_DATA_ROOT:-$(pwd)/data}";STATE="$DATA_ROOT/releases/state.json";[ -f "$STATE" ]||{ echo "没有 release state，无法回滚";exit 1; }
TARGET="$("$OWNWARD_BUN" -e 'const x=JSON.parse(await Bun.file(process.argv[1]).text()),id=x.rollbackCandidate;if(typeof id!=="string"||!/^[a-f0-9]{64}$/.test(id)||id===x.current)process.exit(65);console.log(id)' "$STATE")"||{ echo "没有不同于 current 的已知良好 rollbackCandidate，拒绝振荡回滚";exit 1; }
TARGET_CONFIG_DIGEST="$("$OWNWARD_BUN" -e 'const x=JSON.parse(await Bun.file(process.argv[1]).text()),id=x.rollbackCandidateConfigDigest;if(typeof id==="string"&&/^[a-f0-9]{64}$/.test(id))console.log(id)' "$STATE")"
echo "== rollback immutable release → $TARGET"
OWNWARD_TARGET_RELEASE_ID="$TARGET" OWNWARD_TARGET_CONFIG_DIGEST="$TARGET_CONFIG_DIGEST" OWNWARD_PROVIDER_CANARY=1 OWNWARD_OBSERVATION_SEC="${OWNWARD_OBSERVATION_SEC:-120}" bash launchd/install-release.sh
osascript -e 'display notification "已成对回滚 daemon + Runner" with title "Ownward" sound name "Basso"' 2>/dev/null||true
echo "== rollback done → $TARGET"
