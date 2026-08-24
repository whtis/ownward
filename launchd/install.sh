#!/bin/bash
# Transactionally install/restart only the daemon. Runner lifecycle remains separate.
set -euo pipefail
[ "$(id -u)" -ne 0 ] || { echo "❌ 禁止以 root 安装用户 daemon" >&2; exit 64; }
[ -n "${OWNWARD_RELEASE_ROOT:-}" ] || { echo "❌ launchd/install.sh 是发布事务内部步骤；请从仓库根目录运行 bash install.sh" >&2; exit 64; }
cd "$(dirname "$0")/.."
SOURCE_ROOT="$(pwd)"; ROOT="${OWNWARD_RELEASE_ROOT:-$SOURCE_ROOT}"; DATA_ROOT="${OWNWARD_DATA_ROOT:-$SOURCE_ROOT/data}"; CONFIG_ROOT="${OWNWARD_CONFIG_ROOT:-$SOURCE_ROOT}"
LABEL="ai.ownward.daemon"; DOMAIN="gui/$(id -u)"; BUN="${OWNWARD_BUN:-$(command -v bun || true)}"
[ -n "$BUN" ] && [ -x "$BUN" ] || { echo "❌ 找不到可执行 bun"; exit 69; }
BUILD_IDENTITY="${OWNWARD_BUILD_IDENTITY:-$(cd "$ROOT" && "$BUN" src/runner/build-identity.ts "$ROOT")}"
OBSERVATION_SEC="${OWNWARD_OBSERVATION_SEC:-$(cd "$ROOT" && "$BUN" -e 'import{cfg}from"./src/util.ts";const n=Number(cfg.release?.observationSec??0);if(!Number.isFinite(n)||n<0||n>600)process.exit(64);console.log(Math.floor(n))')}"
PORT="${OWNWARD_DASHBOARD_PORT:-$(cd "$ROOT" && "$BUN" -e 'import{cfg}from"./src/util.ts";console.log(cfg.dashboard?.port||4517)')}"
AGENT_DIR="$HOME/Library/LaunchAgents"; PLIST="$AGENT_DIR/$LABEL.plist"; TMP_PLIST="$(mktemp "$AGENT_DIR/.$LABEL.tmp.XXXXXX")"; BACKUP=""; TRANSACTION=0; COMMITTED=0; RESTORING=0
mkdir -p "$AGENT_DIR" "$DATA_ROOT/logs"; chmod 700 "$DATA_ROOT" "$DATA_ROOT/logs"; touch "$DATA_ROOT/logs/daemon.log"; chmod 600 "$DATA_ROOT/logs/daemon.log"
bootstrap_retry(){ for _ in 1 2 3 4 5;do launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null&&return 0;sleep 2;done;return 1; }
probe_expected(){ local expected="$1" body;if [ -z "$expected" ];then curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/state" >/dev/null;return;fi;body="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/system/runtime-health")"||return 1; "$BUN" -e 'const x=JSON.parse(process.argv[1]);if(x.ok!==true||x.listening!==true||x.schemaCompatible!==true||!Number.isSafeInteger(x.pid)||x.pid<=0||typeof x.generation!=="string"||!x.generation||x.buildIdentity!==process.argv[2])process.exit(1)' "$body" "$expected"; }
probe(){ probe_expected "$BUILD_IDENTITY"; }
health_deadline(){ for _ in $(seq 1 30);do probe&&return 0;sleep 1;done;return 1; }
restore_previous(){ [ "$RESTORING" = 0 ]||return 1;RESTORING=1;launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null||true;if [ -n "$BACKUP" ]&&[ -f "$BACKUP" ];then mv -f "$BACKUP" "$PLIST";chmod 600 "$PLIST";bootstrap_retry||return 1;for _ in $(seq 1 30);do probe_expected "$OLD_BUILD_IDENTITY"&&return 0;sleep 1;done;return 1;else rm -f "$PLIST";fi; }
cleanup(){ rm -f "$TMP_PLIST";[ -z "$BACKUP" ]||rm -f "$BACKUP"; }
on_exit(){ rc=$?;trap - EXIT ERR;if [ "$rc" -ne 0 ]&&[ "$TRANSACTION" = 1 ]&&[ "$COMMITTED" = 0 ];then echo "Daemon install failed; restoring previous launchd definition" >&2;restore_previous||{ cleanup;echo "❌ previous daemon restore failed" >&2;exit 70;};fi;cleanup;exit "$rc"; }
trap on_exit EXIT;trap 'exit $?' ERR;trap 'exit 130' INT;trap 'exit 143' TERM

# Runner is already installed by the release transaction, but daemon independently enforces protocol/capability/build.
SESSION_MODE="$(cd "$ROOT"&&"$BUN" -e 'import{cfg}from"./src/util.ts";import{parseSessionMigrationMode,validateSessionRunnerTaskIds}from"./src/kernel/sessions/contracts.ts";const m=parseSessionMigrationMode(cfg.architecture?.sessionRunnerMode);if(m==="runner")validateSessionRunnerTaskIds(cfg.architecture?.sessionRunnerTaskIds);console.log(m)')"
# codebuddy 故意不进 required 清单：第三方网关登录态随时会过期，不能让它挡住核心发布门（Runner 注册即可用，坏了只影响自己）
REQUIRED_PROVIDERS="$(cd "$ROOT"&&OWNWARD_CONFIG_ROOT="$CONFIG_ROOT" "$BUN" -e 'import{cfg}from"./src/util.ts";console.log(Object.entries(cfg.providers??{}).filter(([,v])=>v?.enabled!==false).map(([id])=>id==="claude-code"?"claude":id).filter(id=>id==="claude"||id==="codex").join(" "))')"
# ${args[@]+...}：零 provider 机器（全部 enabled:false）下 args 是空数组，macOS bash 3.2 在 set -u 下
# 展开空数组会报 unbound variable 直接崩装机——这个写法让空数组安全地展开成零个参数
runner_status(){ local args=();for provider in $REQUIRED_PROVIDERS;do args+=(--required-provider "$provider");done;(cd "$ROOT"&&OWNWARD_DATA_ROOT="$DATA_ROOT" "$BUN" src/runner/health.ts --expected-build "$BUILD_IDENTITY" ${args[@]+"${args[@]}"}); }
if [ "$SESSION_MODE" = runner ];then STATUS="$(runner_status)";fi

cp "$ROOT/launchd/ownward.plist.template" "$TMP_PLIST"
sed -e "s|__LABEL__|$LABEL|g" -e "s|__ROOT__|$ROOT|g" -e "s|__DATA_ROOT__|$DATA_ROOT|g" -e "s|__SOURCE_ROOT__|$SOURCE_ROOT|g" -e "s|__CONFIG_ROOT__|$CONFIG_ROOT|g" -e "s|__BUILD_IDENTITY__|$BUILD_IDENTITY|g" -e "s|__HOME__|$HOME|g" -e "s|__BUN__|$BUN|g" -e "s|__PATH__|$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin|g" "$TMP_PLIST" > "$TMP_PLIST.rendered";mv "$TMP_PLIST.rendered" "$TMP_PLIST";plutil -lint "$TMP_PLIST" >/dev/null
OLD_BUILD_IDENTITY="";if [ -f "$PLIST" ];then OLD_BUILD_IDENTITY="$(plutil -convert json -o - "$PLIST" 2>/dev/null|"$BUN" -e 'try{const x=JSON.parse(await Bun.stdin.text());console.log(x.EnvironmentVariables?.OWNWARD_BUILD_IDENTITY??"")}catch{console.log("")}'||true)";BACKUP="$(mktemp "$AGENT_DIR/.$LABEL.rollback.XXXXXX")";cp "$PLIST" "$BACKUP";chmod 600 "$BACKUP";fi
TRANSACTION=1;mv -f "$TMP_PLIST" "$PLIST";chmod 600 "$PLIST";launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null||true;launchctl enable "$DOMAIN/$LABEL";bootstrap_retry;health_deadline
# provider 只比身份字段（id/version/capabilities）：lastSuccessAt/metrics/activeDepth 是流量易变字段——
# daemon 启动的 resumePending 会在观察窗内合法重放未终态命令（at-least-once 设计），拿易变字段全等比较
# 会把自己的恢复动作误判成漂移，形成「有悬置命令→部署必回滚」死循环（2026-08-20 连炸两次的教训）
if [ "$OBSERVATION_SEC" -gt 0 ];then
  DAEMON_BASE="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/system/runtime-health")"||exit 70
  RUNNER_BASE="$(runner_status)"||exit 70
  for _ in $(seq 1 "$OBSERVATION_SEC");do
    DAEMON_NOW="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/system/runtime-health")"||{ echo "❌ observation daemon probe failed" >&2;exit 70; }
    RUNNER_NOW="$(runner_status)"||{ echo "❌ observation Runner probe failed" >&2;exit 70; }
    "$BUN" -e 'const [d0,d1,r0,r1]=process.argv.slice(1).map(JSON.parse);const fail=(m)=>{console.error(`❌ observation identity drift: ${m}`);process.exit(70)};for(const k of ["pid","generation","buildIdentity"])if(d0[k]!==d1[k])fail(`daemon ${k}`);for(const k of ["pid","buildIdentity","runnerApiVersion"])if(r0[k]!==r1[k])fail(`Runner ${k}`);if(r1.draining!==false)fail("Runner draining");if(JSON.stringify(r0.capabilities)!==JSON.stringify(r1.capabilities))fail("Runner capabilities");const identity=(ps)=>(ps??[]).map(({id,version,capabilities})=>({id,version,capabilities}));if(JSON.stringify(identity(r0.providers))!==JSON.stringify(identity(r1.providers)))fail("Runner providers");' "$DAEMON_BASE" "$DAEMON_NOW" "$RUNNER_BASE" "$RUNNER_NOW"||exit 70
    sleep 1
  done
fi
COMMITTED=1;echo "✅ Ownward daemon installed and observed (${OBSERVATION_SEC}s, build=$BUILD_IDENTITY)"
