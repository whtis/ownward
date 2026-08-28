#!/bin/bash
# 只由一次性 launchd job 执行。它不属于 daemon 的进程组，因此 daemon bootout 后仍能完成探活/回滚。
set -uo pipefail
ACTION="${1:-}"; shift || true
cd "$(dirname "$0")/.." || exit 70
ROOT="$(pwd)"
: "${OWNWARD_BUN:?launchd plist must provide absolute OWNWARD_BUN}"
[ -x "$OWNWARD_BUN" ] || { echo "OWNWARD_BUN is not executable: $OWNWARD_BUN"; exit 69; }
write_intent() {
  "$OWNWARD_BUN" src/deploy-helper.ts --write-intent "deploy-helper:$ACTION"
}

install_and_probe() {
  write_intent || { echo "restart intent gate refused deploy"; return 75; }
  OWNWARD_OBSERVATION_SEC="${OWNWARD_OBSERVATION_SEC:-120}" OWNWARD_PROVIDER_CANARY="${OWNWARD_PROVIDER_CANARY:-1}" bash launchd/install-release.sh
}

case "$ACTION" in
  restart)
    sleep 2
    install_and_probe
    ;;
  apply)
    WT="${1:-}"; BR="${2:-}"; TASK_ID="${3:-}"; ATTEMPT_ID="${4:-}"; EXPECTED_BUILD="${5:-}"
    sleep 2
    if OUTPUT="$(OWNWARD_EVOLVE_ATTEMPT_ID="$ATTEMPT_ID" OWNWARD_EXPECTED_BUILD="$EXPECTED_BUILD" install_and_probe 2>&1)";then RC=0;else RC=$?;fi;printf '%s\n' "$OUTPUT";if [ "$RC" -ne 0 ];then [ -z "$TASK_ID" ]||"$OWNWARD_BUN" scripts/deploy-result.ts "$TASK_ID" "$ATTEMPT_ID" "$EXPECTED_BUILD" failed "release helper exit $RC";exit "$RC";fi
    # committed build 的权威来源是 durable 落盘的 state.json（current + evolveAttemptId 双核对）；
    # 解析 stdout 的 sed 只留作兜底——install-release.sh 改一个 echo 前缀不该把成功发布标成失败
    STATE_JSON="${OWNWARD_DATA_ROOT:-$ROOT/data}/releases/state.json"
    COMMITTED_BUILD=""
    if [ -f "$STATE_JSON" ]; then
      COMMITTED_BUILD="$("$OWNWARD_BUN" -e 'const s=JSON.parse(await Bun.file(process.argv[1]).text());if(!process.argv[2]||s.evolveAttemptId===process.argv[2])console.log(s.current||"")' "$STATE_JSON" "$ATTEMPT_ID" 2>/dev/null || true)"
    fi
    [ -n "$COMMITTED_BUILD" ] || COMMITTED_BUILD="$(printf '%s\n' "$OUTPUT"|sed -n 's/^✅ release committed: //p'|tail -1)"
    if [ -z "$EXPECTED_BUILD" ]||[ "$COMMITTED_BUILD" != "$EXPECTED_BUILD" ];then "$OWNWARD_BUN" scripts/deploy-result.ts "$TASK_ID" "$ATTEMPT_ID" "$EXPECTED_BUILD" failed "committed build mismatch: ${COMMITTED_BUILD:-missing}";exit 76;fi
    [ -z "$TASK_ID" ]||"$OWNWARD_BUN" scripts/deploy-result.ts "$TASK_ID" "$ATTEMPT_ID" "$COMMITTED_BUILD" applied
    [ -n "$WT" ] && git worktree remove --force "$WT" 2>/dev/null || true
    [ -n "$BR" ] && git branch -d "$BR" 2>/dev/null || true
    git push origin main 2>/dev/null && echo "pushed to origin" || true
    osascript -e 'display notification "演进已上线，daemon 已重启" with title "Ownward" sound name "Glass"' 2>/dev/null || true
    ;;
  rollback)
    exec bash scripts/rollback.sh --helper
    ;;
  settings-apply)
    OPERATION_ID="${1:-}"
    [ -n "$OPERATION_ID" ] || { echo "settings-apply requires operation id"; exit 64; }
    exec "$OWNWARD_BUN" src/settings/helper-cli.ts apply "$OPERATION_ID"
    ;;
  settings-recover)
    exec "$OWNWARD_BUN" src/settings/helper-cli.ts recover
    ;;
  *) echo "unknown deploy action: $ACTION"; exit 64 ;;
esac
