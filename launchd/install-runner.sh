#!/bin/bash
# Runner 生命周期与 daemon 隔离；仅显式执行本脚本才安装。
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "❌ 禁止以 root 安装用户级 Runner" >&2; exit 64; }
cd "$(dirname "$0")/.."
SOURCE_ROOT="$(pwd)"; ROOT="${OWNWARD_RELEASE_ROOT:-$SOURCE_ROOT}"; DATA_ROOT="${OWNWARD_DATA_ROOT:-$SOURCE_ROOT/data}"; CONFIG_ROOT="${OWNWARD_CONFIG_ROOT:-$SOURCE_ROOT}"; LABEL="ai.ownward.runner"; DOMAIN="gui/$(id -u)"; BUN="${OWNWARD_BUN:-$(command -v bun || true)}"
FORCE=0; REPAIR=0; [ "${1:-}" = "--force" ] && FORCE=1; if [ "${1:-}" = "--repair" ] && [ "${2:-}" = "CONFIRM_NO_ACTIVE_RUNNER" ]; then REPAIR=1; fi
[ -n "$BUN" ] && [ -x "$BUN" ] || { echo "❌ 找不到可执行 bun"; exit 69; }

AGENT_DIR="$HOME/Library/LaunchAgents"; PLIST="$AGENT_DIR/${LABEL}.plist"; LOCK="$AGENT_DIR/.${LABEL}.install.lock"; BUILD_IDENTITY="${OWNWARD_BUILD_IDENTITY:-$(cd "$ROOT" && "$BUN" src/runner/build-identity.ts "$ROOT")}"
mkdir -p "$DATA_ROOT/logs" "$AGENT_DIR"; chmod 700 "$DATA_ROOT" "$DATA_ROOT/logs"; touch "$DATA_ROOT/logs/runner.log"; chmod 600 "$DATA_ROOT/logs/runner.log"
if ! mkdir "$LOCK" 2>/dev/null; then old_pid="$(sed -n 's/^pid=//p' "$LOCK/owner" 2>/dev/null || true)"; [[ "$old_pid" =~ ^[1-9][0-9]*$ ]] || { echo "❌ 安装锁 owner 非法，拒绝自动清理" >&2; exit 75; }; if kill -0 "$old_pid" 2>/dev/null; then echo "❌ Runner 安装器已有实例在运行(pid=$old_pid)" >&2; exit 75; fi; [ "$(find "$LOCK" -mindepth 1 -maxdepth 1 -print 2>/dev/null)" = "$LOCK/owner" ] || { echo "❌ 安装锁内容异常，拒绝自动清理" >&2; exit 75; }; stale="$AGENT_DIR/.${LABEL}.install.stale.$$.$RANDOM"; mv "$LOCK" "$stale" 2>/dev/null || { echo "❌ stale 安装锁已被其他安装器认领，请重试" >&2; exit 75; }; if ! mkdir "$LOCK" 2>/dev/null; then rm -f "$stale/owner"; rmdir "$stale" 2>/dev/null || true; echo "❌ 安装锁竞争失败，请重试" >&2; exit 75; fi; rm -f "$stale/owner"; rmdir "$stale" 2>/dev/null || { echo "❌ stale 安装锁清理失败" >&2; exit 75; }; fi
echo "pid=$$" > "$LOCK/owner"; chmod 700 "$LOCK"; chmod 600 "$LOCK/owner"
TMP_PLIST="$(mktemp "$AGENT_DIR/.${LABEL}.tmp.XXXXXX")"; BACKUP=""; TRANSACTION=0; COMMITTED=0; RESTORING=0; QUIESCED=0; OLD_PID=0; STRICT_EXPECT=0
REQUIRED_PROVIDERS="$(cd "$ROOT"&&OWNWARD_CONFIG_ROOT="$CONFIG_ROOT" "$BUN" -e 'import{cfg}from"./src/util.ts";console.log(Object.entries(cfg.providers??{}).filter(([,v])=>v?.enabled!==false).map(([id])=>id==="claude-code"?"claude":id).filter(id=>id==="claude"||id==="codex").join(" "))' 2>/dev/null||printf 'claude codex')"

parse_health() { "$BUN" -e 'const x=JSON.parse(process.argv[1]);if(x.ok!==true||!Number.isSafeInteger(x.pid)||x.pid<0||typeof x.draining!=="boolean"||!Array.isArray(x.activeRuns)||x.activeRuns.some(v=>typeof v!=="string")||(x.runnerApiVersion!==undefined&&!Number.isSafeInteger(x.runnerApiVersion))||(x.capabilities!==undefined&&(!Array.isArray(x.capabilities)||x.capabilities.some(v=>typeof v!=="string"))))process.exit(65);console.log(x.activeRuns.length)' "$1"; }
# REQUIRED_PROVIDERS 来自【新】配置，只能用来验证【重启后】的新 Runner。
# 升级前的探针面对的是按旧配置启动的旧 Runner——新启用一个 provider（如 codex 从 disabled 改 enabled）时
# 旧 Runner 必然没注册它，若在此强求就会「任何新增 provider 都被自己卡死」，还误报成「Runner 不可达」
# 故 providers 与 expected-build 一样只在 strict 阶段生效。
strict_args() { [ "$STRICT_EXPECT" = 0 ] && return 0;printf '%s\n' --expected-build "$BUILD_IDENTITY";for provider in $REQUIRED_PROVIDERS;do printf '%s\n' --required-provider "$provider";done; }
health_json() { local args=(); while IFS= read -r value; do args+=("$value"); done < <(strict_args); (cd "$ROOT" && OWNWARD_DATA_ROOT="$DATA_ROOT" "$BUN" src/runner/health.ts "$@" ${args[@]+"${args[@]}"}) 2>/dev/null; }
health_probe() { local args=(); while IFS= read -r value; do args+=("$value"); done < <(strict_args); (cd "$ROOT" && OWNWARD_DATA_ROOT="$DATA_ROOT" "$BUN" src/runner/health.ts "$@" ${args[@]+"${args[@]}"}) 2>&1; }
supports() { "$BUN" -e 'const x=JSON.parse(process.argv[1]);process.exit(Array.isArray(x.capabilities)&&x.capabilities.includes(process.argv[2])?0:1)' "$1" "$2"; }
require_draining() { "$BUN" -e 'process.exit(JSON.parse(process.argv[1]).draining===true?0:1)' "$1"; }
require_not_draining() { "$BUN" -e 'process.exit(JSON.parse(process.argv[1]).draining===false?0:1)' "$1"; }
bootstrap_retry() { local i; for i in 1 2 3 4 5; do launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null && return 0; sleep 2; done; return 1; }
health_deadline() { local expected="${1:-0}" i status; STRICT_EXPECT="$expected"; for i in $(seq 1 30); do if status="$(health_json)" && parse_health "$status" >/dev/null; then LAST_HEALTH="$status"; STRICT_EXPECT=0; return 0; fi; sleep 1; done; STRICT_EXPECT=0; return 1; }
resume_existing() { local status; status="$(health_json)" || return 1; supports "$status" resume || return 0; health_json --resume-control-only >/dev/null || return 1; status="$(health_json)" || return 1; parse_health "$status" >/dev/null || return 1; require_not_draining "$status" || return 1; QUIESCED=0; }
restore_previous() {
  [ "$RESTORING" = 0 ] || return 1; RESTORING=1
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then mv -f "$BACKUP" "$PLIST"; chmod 600 "$PLIST"; launchctl enable "$DOMAIN/$LABEL" && bootstrap_retry && health_deadline
  else rm -f "$PLIST"; fi
}
cleanup() { rm -f "$TMP_PLIST"; [ -z "$BACKUP" ] || rm -f "$BACKUP"; rm -f "$LOCK/owner" 2>/dev/null || true; rmdir "$LOCK" 2>/dev/null || true; }
on_exit() { local rc=$?; trap - EXIT ERR; trap '' INT TERM; if [ "$rc" -ne 0 ] && [ "$TRANSACTION" = 1 ] && [ "$COMMITTED" = 0 ]; then echo "Runner install failed; restoring previous launchd definition" >&2; if ! restore_previous; then cleanup; echo "❌ previous Runner restore/health failed" >&2; exit 70; fi; fi; if [ "$rc" -ne 0 ] && [ "$QUIESCED" = 1 ]; then resume_existing || { cleanup; echo "❌ failed to resume previous Runner" >&2; exit 70; }; fi; cleanup; exit "$rc"; }
on_error() { local rc=$?; trap - ERR; exit "$rc"; }
trap on_exit EXIT
trap on_error ERR
trap 'exit 130' INT
trap 'exit 143' TERM

cp "$ROOT/launchd/ownward-runner.plist.template" "$TMP_PLIST"
PROGRAM_ARGUMENTS_JSON="$("$BUN" -e 'console.log(JSON.stringify([process.argv[1], "src/runner/entry.ts"]))' "$BUN")"
plutil -replace ProgramArguments -json "$PROGRAM_ARGUMENTS_JSON" "$TMP_PLIST"
plutil -replace WorkingDirectory -string "$ROOT" "$TMP_PLIST"
plutil -replace EnvironmentVariables.HOME -string "$HOME" "$TMP_PLIST"
# /usr/sbin：codebuddy 等 CLI 的系统探测（ioreg）在这里，缺了只会刷 stderr 噪音
plutil -replace EnvironmentVariables.PATH -string "$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" "$TMP_PLIST"
plutil -replace EnvironmentVariables.OWNWARD_DATA_ROOT -string "$DATA_ROOT" "$TMP_PLIST"
plutil -replace EnvironmentVariables.OWNWARD_SOURCE_ROOT -string "$SOURCE_ROOT" "$TMP_PLIST"
plutil -replace EnvironmentVariables.OWNWARD_CONFIG_ROOT -string "$CONFIG_ROOT" "$TMP_PLIST"
plutil -replace EnvironmentVariables.OWNWARD_RUNNER_BUILD_IDENTITY -string "$BUILD_IDENTITY" "$TMP_PLIST"
plutil -replace StandardOutPath -string "$DATA_ROOT/logs/runner.log" "$TMP_PLIST"
plutil -replace StandardErrorPath -string "$DATA_ROOT/logs/runner.log" "$TMP_PLIST"
plutil -lint "$TMP_PLIST" >/dev/null

# 不依赖 job registry 的展示状态：旧 plist 存在即要求 capability-authenticated health。
if [ -f "$PLIST" ]; then
  if ! STATUS="$(health_probe)"; then
    [ "$REPAIR" = 1 ] || { echo "❌ 已安装 Runner 不可达；仅核实无活进程后可用 --repair CONFIRM_NO_ACTIVE_RUNNER" >&2; exit 69; }
    echo "$STATUS" | grep -Eq 'ENOENT|ECONNREFUSED' || { echo "❌ repair 只接受明确的 socket 不存在/拒绝连接" >&2; exit 69; }
    INSTANCE_DIR="$DATA_ROOT/runner/.instance-lock"; INSTANCE="$INSTANCE_DIR/owner.json"; SOCKET="$DATA_ROOT/runner/runner.sock"; if [ -e "$SOCKET" ] || [ -L "$SOCKET" ]; then echo "❌ repair 拒绝：Runner socket 路径仍存在" >&2; exit 75; fi; if [ -d "$INSTANCE_DIR" ]; then [ -f "$INSTANCE" ] || { echo "❌ repair 拒绝：instance lock owner 缺失" >&2; exit 75; }; pid="$("$BUN" -e 'try{const x=JSON.parse(await Bun.file(process.argv[1]).text());if(!Number.isSafeInteger(x.pid)||x.pid<=0)process.exit(1);console.log(x.pid)}catch{process.exit(1)}' "$INSTANCE")" || { echo "❌ repair 拒绝：instance lock owner 非法" >&2; exit 75; }; ! kill -0 "$pid" 2>/dev/null || { echo "❌ repair 拒绝：Runner pid $pid 仍存活" >&2; exit 75; }; rm -f "$INSTANCE"; rmdir "$INSTANCE_DIR" 2>/dev/null || { echo "❌ repair 拒绝：instance lock 含未知内容" >&2; exit 75; }; fi; printf '%s\n' "$(date -u +%FT%TZ) repair-confirmed pid=$$" >> "$DATA_ROOT/runner-repair-audit.log"; chmod 600 "$DATA_ROOT/runner-repair-audit.log"; STATUS='{"ok":true,"pid":0,"draining":false,"activeRuns":[]}';
  fi
  ACTIVE="$(parse_health "$STATUS")" || { echo "❌ Runner health schema 非法，拒绝升级" >&2; exit 65; }
  OLD_PID="$("$BUN" -e 'console.log(JSON.parse(process.argv[1]).pid||0)' "$STATUS")"
  [ "$FORCE" = 0 ] || echo "⚠️ --force 不再绕过 active-run 安全门" >&2
  if supports "$STATUS" quiesce; then health_json --quiesce-control-only >/dev/null; QUIESCED=1; STATUS="$(health_json)"; ACTIVE="$(parse_health "$STATUS")"; require_draining "$STATUS"; fi
  for _ in $(seq 1 60); do [ "$ACTIVE" -eq 0 ] && break; sleep 1; STATUS="$(health_json)" || exit 69; ACTIVE="$(parse_health "$STATUS")" || exit 65; done
  [ "$ACTIVE" -eq 0 ] || { echo "❌ Runner drain 超时，仍有 $ACTIVE 个 active run" >&2; exit 75; }
  # TOCTOU 门：Runner 已 quiesce，且紧邻 bootout 再确认一次没有 active command。
  if [ "$REPAIR" = 1 ]; then STATUS='{"ok":true,"pid":0,"draining":false,"activeRuns":[]}'; elif [ "$QUIESCED" = 1 ]; then health_json --quiesce-control-only >/dev/null; STATUS="$(health_json)"; else STATUS="$(health_json)"; fi; ACTIVE="$(parse_health "$STATUS")"; [ "$ACTIVE" -eq 0 ] || { echo "❌ Runner 在切换前重新出现 active run" >&2; exit 75; }
fi

if [ -f "$PLIST" ]; then BACKUP="$(mktemp "$AGENT_DIR/.${LABEL}.rollback.XXXXXX")"; cp "$PLIST" "$BACKUP"; chmod 600 "$BACKUP"; fi
TRANSACTION=1
mv -f "$TMP_PLIST" "$PLIST"; chmod 600 "$PLIST"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl enable "$DOMAIN/$LABEL"
bootstrap_retry
health_deadline 1
NEW_PID="$("$BUN" -e 'const x=JSON.parse(process.argv[1]);if(!Number.isSafeInteger(x.pid)||x.pid<=0||x.buildIdentity!==process.argv[2])process.exit(1);console.log(x.pid)' "$LAST_HEALTH" "$BUILD_IDENTITY")"
[ "$OLD_PID" -eq 0 ] || [ "$NEW_PID" -ne "$OLD_PID" ] || { echo "❌ 新 Runner pid 未变化，拒绝旧进程假健康" >&2; exit 70; }
COMMITTED=1
echo "✅ Ownward Runner installed and healthy; daemon lifecycle was not touched"
