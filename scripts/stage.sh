#!/bin/bash
# 预发布：dev 分支在 ../dev 以「生产配置 + 安全覆盖」起一套（端口 4519，覆盖规则见 scripts/stage-config.ts）。
# verify → 起 dev 的 Runner + daemon → 接口探活 + 页面冒烟，全过才记「这个提交预发布通过」；
# promote 只认这个记录：把同一个提交快进到生产 master、push、等生产 Runner 空闲、跑 install.sh。
#
#   bash scripts/stage.sh [--ref <分支>] [--with <vertical,...>] [--skip-verify]   合入（可选）并预发布
#   bash scripts/stage.sh status | stop | promote
#   （装好后也可以 own stage …）
set -uo pipefail

SELF_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PROD="$(git -C "$SELF_ROOT" worktree list --porcelain | awk '/^worktree /{print $2; exit}')"
DEV="$(dirname "$PROD")/dev"
STATE="$DEV/data/staging"
PORT=4519
URL="http://127.0.0.1:$PORT"
BUN="$(command -v bun || echo /opt/homebrew/bin/bun)"
# daemon/Runner 派生的 shell 带着生产的这几个变量；不清掉，dev 进程就会读生产的源码根和配置快照（同 verify.sh）
unset OWNWARD_SOURCE_ROOT OWNWARD_CONFIG_ROOT OWNWARD_BUILD_IDENTITY OWNWARD_RELEASE_ROOT OWNWARD_RUNNER_BUILD_IDENTITY OWNWARD_DATA_ROOT

say()  { printf "\n== %s\n" "$1"; }
ok()   { echo "   ✅ $1"; }
fail() { echo "   ❌ $1" >&2; exit "${2:-1}"; }

ensure_dev() {
  [ -n "$PROD" ] && [ -d "$PROD/.git" ] || fail "找不到生产检出（git worktree list 的第一项）"
  if [ ! -d "$DEV" ]; then
    git -C "$PROD" show-ref --verify --quiet refs/heads/dev || git -C "$PROD" branch dev master
    git -C "$PROD" worktree add "$DEV" dev >/dev/null || fail "建 dev worktree 失败：$DEV"
  fi
  [ "$(git -C "$DEV" branch --show-current)" = "dev" ] || fail "$DEV 不在 dev 分支上"
  mkdir -p "$STATE" && chmod 700 "$STATE"
}

# 只杀确实是 dev 检出里跑起来的进程——端口/pid 被别的进程占着时宁可报错也不误杀
ours() { local pid="$1"; [ -n "$pid" ] && ps -p "$pid" -o command= 2>/dev/null | grep -qF "$DEV/src/"; }
entry_of() { case "$1" in runner) echo "$DEV/src/runner/entry.ts" ;; daemon) echo "$DEV/src/daemon.ts" ;; esac; }
# 按命令行里的绝对入口找全部实例，不只信 pid 文件：pid 文件过期时旧 Runner 会一直占着实例锁，
# 新 Runner 起不来、健康检查却被旧的答了——dev 上跑的就不是刚合入的代码（2026-09-22 实撞）
pids_of() { pgrep -f -- "$(entry_of "$1")" 2>/dev/null | while read -r p; do ours "$p" && echo "$p"; done; }
stop_one() {
  local name="$1" pid
  for pid in $(pids_of "$name"); do
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$pid" 2>/dev/null || true
    echo "   · 停了 dev ${name}（pid ${pid}）"
  done
  rm -f "$STATE/$name.pid"
}
stop_all() {
  stop_one daemon; stop_one runner
  local holder; holder="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
  if [ -n "$holder" ]; then
    if ours "$holder"; then kill "$holder" 2>/dev/null; sleep 1; kill -9 "$holder" 2>/dev/null || true
    else fail "端口 $PORT 被别的进程占着（pid ${holder}），不是 dev 检出里的 daemon，没动它"; fi
  fi
}

start_bg() {   # start_bg <name>：nohup 常驻（关终端也不跟着死）；exec 让记下的 pid 就是 bun 本身
  local name="$1"
  # 用绝对路径起：ours()/pids_of() 靠命令行里的入口路径认领进程
  ( cd "$DEV" || exit 1; OWNWARD_DATA_ROOT="$DEV/data" exec nohup "$BUN" "$(entry_of "$name")" >> "$STATE/$name.log" 2>&1 ) &
  echo $! > "$STATE/$name.pid"
}

# 健康且就是这一轮刚起的那个进程（pid 对得上），旧实例冒充不了
runner_healthy() {
  local want; want="$(cat "$STATE/runner.pid" 2>/dev/null)"
  (cd "$DEV" && OWNWARD_DATA_ROOT="$DEV/data" "$BUN" src/runner/health.ts 2>/dev/null) | "$BUN" -e 'const x=JSON.parse(await Bun.stdin.text());process.exit(x.ok===true&&String(x.pid)===process.argv[1]?0:1)' "$want" 2>/dev/null
}

up() {
  local ref="" with="" skip_verify=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --ref) [ $# -ge 2 ] || fail "--ref 后面要跟分支名" 64; ref="$2"; shift 2 ;;
      --with) [ $# -ge 2 ] || fail "--with 后面要跟 vertical 名（逗号分隔）" 64; with="$2"; shift 2 ;;
      --skip-verify) skip_verify=1; shift ;;
      *) fail "未知参数：$1（用法见脚本开头）" 64 ;;
    esac
  done
  ensure_dev
  say "1/6 dev 分支"
  [ -z "$(git -C "$DEV" status --porcelain)" ] || fail "$DEV 有未提交的改动：预发布只认提交过的代码（先提交或清掉）"
  if [ -n "$ref" ]; then git -C "$DEV" merge --ff-only "$ref" >/dev/null || fail "dev 快进到 $ref 失败：dev 和 $ref 分叉了，先 rebase"; fi
  local head; head="$(git -C "$DEV" rev-parse HEAD)"
  rm -f "$STATE/passed.json"   # 这一轮没跑完之前，任何旧的「通过」记录都不作数
  ok "dev @ $(git -C "$DEV" log --oneline -1)"

  say "2/6 验证门（verify.sh）"
  if [ "$skip_verify" = 1 ]; then echo "   ⚠ 跳过了 verify.sh（--skip-verify）"
  else (cd "$DEV" && ./verify.sh >"$STATE/verify.log" 2>&1) || { tail -20 "$STATE/verify.log"; fail "verify.sh 没过（全文：$STATE/verify.log）"; }; ok "verify.sh 通过"; fi

  say "3/6 预发布配置（生产 config.json + 安全覆盖）"
  local info vault_src
  info="$("$BUN" "$DEV/scripts/stage-config.ts" --prod "$PROD" --dev "$DEV" --with "$with")" || fail "生成 dev 配置失败"
  vault_src="$(printf '%s' "$info" | "$BUN" -e 'console.log(JSON.parse(await Bun.stdin.text()).vaultSource)')"
  printf '%s' "$info" | "$BUN" -e 'const x=JSON.parse(await Bun.stdin.text());console.log(`   · 覆盖了 ${x.overrides.length} 项：${x.overrides.join("、")}`);if(x.verticals.length)console.log(`   ⚠ 打开了外接 vertical：${x.verticals.join("、")}（连的是真实数据）`)'
  mkdir -p "$DEV/data/staging-vault"
  if [ -d "$vault_src" ]; then rsync -a --delete --exclude='.*' "$vault_src/" "$DEV/data/staging-vault/" || fail "同步 vault 拷贝失败"; ok "vault 拷贝已同步（$vault_src → data/staging-vault）"
  else echo "   ⚠ 生产 vault 不存在：${vault_src}，dev 用空 vault"; fi

  say "4/6 起 dev 的 Runner 与 daemon（端口 ${PORT}）"
  stop_all
  start_bg runner
  for _ in $(seq 1 40); do runner_healthy && break; sleep 0.5; done
  runner_healthy || { tail -20 "$STATE/runner.log"; fail "dev Runner 没起来（日志：$STATE/runner.log）"; }
  ok "Runner 健康（pid $(cat "$STATE/runner.pid")）"
  start_bg daemon
  local state=""
  for _ in $(seq 1 60); do state="$(curl -sf "$URL/api/state" 2>/dev/null)" && break; sleep 1; done
  [ -n "$state" ] || { tail -20 "$STATE/daemon.log"; fail "dev daemon 没起来（日志：$STATE/daemon.log）"; }
  printf '%s' "$state" | grep -q '"staging":true' || fail "$URL 上的实例不是预发布模式（staging 标记缺失），不敢往下走"
  printf '%s' "$state" | "$BUN" -e 'process.exit(String(JSON.parse(await Bun.stdin.text()).pid)===process.argv[1]?0:1)' "$(cat "$STATE/daemon.pid")" \
    || fail "$URL 上答话的不是这一轮刚起的 daemon（pid 对不上），旧实例没停干净"
  ok "daemon 就绪（pid $(cat "$STATE/daemon.pid")）"

  say "5/6 接口探活"
  local bad=0 ep
  for ep in api/state "api/feed?limit=1" api/tasks api/chat/list api/vault/list api/vault/prefs api/providers/catalog api/dev/recent; do
    if curl -sf -o /dev/null "$URL/$ep"; then ok "$ep"; else echo "   ❌ $ep"; bad=1; fi
  done
  if printf '%s' "$state" | "$BUN" -e 'const s=JSON.parse(await Bun.stdin.text());process.exit(s.health?.runner?.ok===true?0:1)'; then ok "daemon 看得到 Runner"
  else echo "   ❌ daemon 报 Runner 不可用"; bad=1; fi
  [ "$bad" = 0 ] || fail "接口探活没过（日志：$STATE/daemon.log）"

  say "6/6 页面冒烟（无头 Chrome 逐个打开 tab）"
  "$BUN" "$DEV/scripts/stage-smoke.ts" "$URL" || fail "页面冒烟没过"

  printf '{"commit":"%s","at":"%s","url":"%s","with":"%s","skipVerify":%s}\n' "$head" "$(date -u +%FT%TZ)" "$URL" "$with" "$([ "$skip_verify" = 1 ] && echo true || echo false)" > "$STATE/passed.json"
  echo
  echo "✅ 预发布通过：$(git -C "$DEV" log --oneline -1)"
  echo "   打开 $URL 亲手看一遍（页面顶上挂着「预发布」）；没问题就 bash scripts/stage.sh promote"
}

promote() {
  ensure_dev
  local head passed
  head="$(git -C "$DEV" rev-parse HEAD)"
  passed="$("$BUN" -e 'try{console.log(JSON.parse(await Bun.file(process.argv[1]).text()).commit)}catch{}' "$STATE/passed.json" 2>/dev/null)"
  [ -n "$passed" ] || fail "没有预发布通过的记录：先跑 bash scripts/stage.sh"
  [ "$passed" = "$head" ] || fail "dev 现在是 ${head:0:8}，预发布通过的是 ${passed:0:8}：重新预发布这个提交"
  "$BUN" -e 'process.exit(JSON.parse(await Bun.file(process.argv[1]).text()).skipVerify===true?1:0)' "$STATE/passed.json" \
    || fail "这一轮预发布跳过了 verify.sh（--skip-verify），不能上生产：去掉它重新预发布"
  [ -z "$(git -C "$DEV" status --porcelain)" ] || fail "$DEV 有未提交的改动"
  git -C "$PROD" diff --quiet && git -C "$PROD" diff --cached --quiet || fail "生产检出有未提交的改动，先处理（不会替你丢）"

  say "1/3 合入生产 master 并 push"
  git -C "$PROD" merge --ff-only dev >/dev/null || fail "master 快进不到 dev：master 有 dev 之外的提交，先在 dev 上 rebase master 再预发布"
  ok "master @ $(git -C "$PROD" log --oneline -1)"
  git -C "$PROD" push origin master >/dev/null 2>&1 || git -C "$PROD" push origin master >/dev/null 2>&1 || fail "push 失败（代码已合入本地 master，重试：git -C $PROD push origin master）"
  ok "已 push"

  say "2/3 等生产 Runner 空闲（install.sh 升级 Runner 前只给 60s 排空）"
  local active=""
  for i in $(seq 1 90); do
    active="$(cd "$PROD" && "$BUN" src/runner/health.ts 2>/dev/null | "$BUN" -e 'try{console.log(JSON.parse(await Bun.stdin.text()).activeRuns.length)}catch{console.log("?")}')"
    [ "$active" = "0" ] && break
    [ $((i % 6)) = 1 ] && echo "   · 生产还有 $active 个轮次在跑，等它们结束…"
    sleep 10
  done
  [ "$active" = "0" ] || fail "生产 Runner 15 分钟都没空下来：代码已合入并 push，稍后重跑 promote（只差 install.sh）"
  ok "Runner 空闲"

  say "3/3 生产发布（install.sh：构建 + 观察期 + Provider canary，失败自动回滚）"
  # install.sh 脱离当前 shell 跑：终端/会话中途断开不能把发布事务杀在半路；这边只跟日志等结束标记
  local log="$STATE/install-$(date +%Y%m%d-%H%M%S).log"
  ( cd "$PROD" || exit 1; exec nohup bash -c 'bash install.sh; echo "INSTALL_EXIT $?"' > "$log" 2>&1 ) &
  local installer=$!
  echo "   · 日志：$log"
  tail -n +1 -f "$log" & local tailer=$!
  # 最多等 45 分钟；安装进程没了却没留下结束标记（被系统杀掉之类）也立刻停，别对着日志干等
  local waited=0
  until grep -q "^INSTALL_EXIT " "$log" 2>/dev/null; do
    if ! kill -0 "$installer" 2>/dev/null; then sleep 2; grep -q "^INSTALL_EXIT " "$log" 2>/dev/null && break
      kill "$tailer" 2>/dev/null; fail "install.sh 进程没了但没写结束标记（被杀或崩溃）：看 ${log}，必要时 own status 确认生产状态"; fi
    [ "$waited" -ge 2700 ] && { kill "$tailer" 2>/dev/null; fail "install.sh 45 分钟还没结束：它还在后台跑，看 $log"; }
    sleep 2; waited=$((waited + 2))
  done
  sleep 1; kill "$tailer" 2>/dev/null; wait "$tailer" 2>/dev/null
  local code; code="$(grep "^INSTALL_EXIT " "$log" | tail -1 | awk '{print $2}')"
  [ "$code" = "0" ] || fail "install.sh 失败（退出码 ${code}），已回滚到上一版：$log"
  ok "生产已发布：$(git -C "$PROD" log --oneline -1)"
}

status() {
  ensure_dev
  local head passed; head="$(git -C "$DEV" rev-parse HEAD)"
  passed="$("$BUN" -e 'try{const x=JSON.parse(await Bun.file(process.argv[1]).text());console.log(`${x.commit} ${x.at}`)}catch{}' "$STATE/passed.json" 2>/dev/null)"
  echo "dev:      $(git -C "$DEV" log --oneline -1)"
  echo "生产:     $(git -C "$PROD" log --oneline -1)"
  if [ -n "$passed" ]; then
    [ "${passed%% *}" = "$head" ] && echo "预发布:   ✅ 当前 dev 已通过（${passed#* }）" || echo "预发布:   ⚠ 通过的是 ${passed:0:8}，dev 已经变了"
  else echo "预发布:   还没通过"; fi
  local r d; r="$(pids_of runner | tr '\n' ' ')"; d="$(pids_of daemon | tr '\n' ' ')"
  [ -n "$r" ] && echo "Runner:   运行中（pid ${r% }）" || echo "Runner:   没在跑"
  [ -n "$d" ] && echo "daemon:   运行中（pid ${d% }）→ $URL" || echo "daemon:   没在跑"
  git -C "$PROD" merge-base --is-ancestor "$head" HEAD 2>/dev/null && echo "上线:     dev 这个提交已在生产 master 里" || echo "上线:     还没进生产 master"
}

case "${1:-up}" in
  status) status ;;
  stop) ensure_dev; stop_all; echo "dev 预发布已停" ;;
  promote) promote ;;
  up) shift; up "$@" ;;
  -*) up "$@" ;;
  *) fail "未知子命令：$1（up|status|stop|promote）" 64 ;;
esac
