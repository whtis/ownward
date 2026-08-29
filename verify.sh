#!/bin/bash
# 验证门：演进产物必须全绿才能上线。在仓库根目录（或 worktree 根目录）执行。
set -uo pipefail
cd "$(dirname "$0")"
FAIL=0
VERIFY_DATA_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ownward-verify-data.XXXXXX")"
DPID=""
cleanup() {
  [ -n "${DPID:-}" ] && kill "$DPID" 2>/dev/null || true
  rm -rf "$VERIFY_DATA_ROOT"
}
trap cleanup EXIT
# 环境必须与调用者解耦：daemon/runner 起的 shell（以及它派生的会话）导出着**生产**的
# OWNWARD_SOURCE_ROOT / OWNWARD_CONFIG_ROOT / OWNWARD_BUILD_IDENTITY——CONFIG_ROOT 还指向
# 已冻结的 release 快照。只覆盖 DATA_ROOT 时，测试会读生产的源码根、快照 config 和构建指纹，
# 于是「验证 worktree」变成「验证生产」：实测在 dev worktree 里稳定假失败 10 条
# （installer 事务 7 条 + runner startup gate + terminal adopt + SessionService cwd 授权）。
# 全部 unset：src/util.ts 无 env 时按自身模块位置推 ROOT，正好等于被验证的这个 checkout。
unset OWNWARD_SOURCE_ROOT OWNWARD_CONFIG_ROOT OWNWARD_BUILD_IDENTITY OWNWARD_RELEASE_ROOT OWNWARD_RUNNER_BUILD_IDENTITY
export OWNWARD_DATA_ROOT="$VERIFY_DATA_ROOT"

step() { printf "\n== %s\n" "$1"; }
ok()   { echo "   ✅ $1"; }
bad()  { echo "   ❌ $1"; FAIL=1; }

step "1/7 TS 语法与打包检查"
if bun build src/daemon.ts src/cli.ts src/runner/entry.ts src/runner/health.ts scripts/gmail-auth.ts --target bun --outdir /tmp/ownward-verify-build >/dev/null 2>&1; then
  ok "bun build"
else
  bun build src/daemon.ts src/cli.ts --target bun --outdir /tmp/ownward-verify-build 2>&1 | tail -5
  bad "bun build 失败"
fi
rm -rf /tmp/ownward-verify-build

step "2/7 TS 类型检查（bun build 不查类型：漏必填字段这类错只有 tsc 抓得住）"
[ -x node_modules/.bin/tsc ] || bun install >/dev/null 2>&1   # worktree 里 node_modules 不存在，装 dev 依赖（typescript + @types/bun）
if ./node_modules/.bin/tsc --noEmit >/tmp/ownward-verify-tsc.log 2>&1; then
  ok "tsc --noEmit"
else
  head -8 /tmp/ownward-verify-tsc.log
  bad "tsc 类型检查失败"
fi

step "3/7 单元测试（bun test：src 下全部 *.test.ts，含子目录）"
# bun test 的路径参数是**子串匹配**，不是文件名——这一点要传绝对路径才躲得开：
# 传相对的 src/x.test.ts，bun 会把 data/releases/<hash>/src/x.test.ts 里每一份历史发布
# 快照的同名测试全部匹配上（2026-08-22 主检出实测：单个文件跑成 32 份、100 个文件跑成 266 个，
# 且快照里的旧代码配旧断言 → 一堆假失败）。git ls-files 只保证**列表**干净，挡不住 bun 自己
# 再拿每个相对路径去全仓匹配一遍；绝对路径里快照多出 /data/releases/<hash>/ 一段，不再是子串。
# worktree 里没有 data/releases，所以这个坑只在主检出暴露——别因为 worktree 全绿就以为没事。
# -co 含未提交的新测试，--exclude-standard 吃 .gitignore 排除 data/；NUL 分隔防文件名带空格。
TEST_FILES=()
SERIAL_TEST_FILES=()
while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue  # 已删除但尚未暂存的 tracked test 不应传给 Bun。
  # This test spawns a release shell transaction and deliberately changes
  # filesystem permissions. Keep it in an independent Bun process so no other
  # test file can supply inherited process state to that transaction.
  if [ "$f" = "src/release/install-release-lock.test.ts" ]; then
    SERIAL_TEST_FILES+=("$PWD/$f")
    continue
  fi
  TEST_FILES+=("$PWD/$f")
done \
  < <(git ls-files -zco --exclude-standard -- 'src/**/*.test.ts' 'src/*.test.ts' 2>/dev/null)
if [ "${#TEST_FILES[@]}" -eq 0 ]; then
  bad "找不到任何测试文件（不在 git 仓库里？）"
elif bun test --timeout 15000 "${TEST_FILES[@]}" >/tmp/ownward-verify-test.log 2>&1 && bun test --timeout 15000 "${SERIAL_TEST_FILES[@]}" >>/tmp/ownward-verify-test.log 2>&1; then
  ok "$(grep -oE '[0-9]+ pass' /tmp/ownward-verify-test.log | paste -sd+ -) bun test"
else
  tail -80 /tmp/ownward-verify-test.log
  bad "bun test 失败"
fi

step "4/7 daemon 冒烟启动（测试模式，随机空闲端口）"
# 端口随机 + 应答 pid 必须等于本次启动的 pid。写死 4519 时踩过：dev daemon 占着这个端口，
# 冒烟实例 EADDRINUSE 秒死，探活打到 dev daemon 上照样全绿——这一步等于没测过被改的代码。
BOOT_OK=0
PORT=""
MISMATCH=""
for try in 1 2 3; do
  P=$(( 45000 + RANDOM % 2000 ))
  OWNWARD_TEST=1 OWNWARD_TEST_PORT=$P bun src/daemon.ts >/tmp/ownward-verify-daemon.log 2>&1 &
  DPID=$!
  for i in $(seq 1 20); do
    kill -0 "$DPID" 2>/dev/null || break   # 进程已死（端口被占/启动就崩）：换个端口重来
    GOT=$(curl -sf "http://127.0.0.1:$P/api/state" | grep -o '"pid":[0-9]*' | head -1 | cut -d: -f2)
    [ -z "$GOT" ] && { sleep 0.5; continue; }   # 还没起来
    # 光看「端口有应答」不够：占着这个端口的可能是别的 daemon，探活会打到它身上（曾经的 4519）
    if [ "$GOT" = "$DPID" ]; then BOOT_OK=1; PORT=$P; else MISMATCH="$GOT"; fi
    break
  done
  [ "$BOOT_OK" = 1 ] && break
  kill "$DPID" 2>/dev/null; wait "$DPID" 2>/dev/null
done
if [ "$BOOT_OK" = 1 ]; then
  ok "daemon 启动 + /api/state 探活（pid $DPID @ :${PORT}）"
elif [ -n "$MISMATCH" ]; then
  bad "探活应答来自别的实例（pid=$MISMATCH）：端口被占，换 3 次都没抢到——这一步测不到被改的代码"
else
  tail -5 /tmp/ownward-verify-daemon.log
  bad "daemon 启动或探活失败"
fi

step "5/7 核心 API 探活"
if [ "$BOOT_OK" = 1 ]; then
  for ep in "api/feed?limit=1" "api/tasks" "api/chat/list" "api/vault/list" "api/logs?lines=1" "app.js" "image-viewer.js" "style.css"; do
    if curl -sf "http://127.0.0.1:$PORT/$ep" >/dev/null 2>&1; then ok "$ep"; else bad "$ep"; fi
  done
fi
kill $DPID 2>/dev/null; wait $DPID 2>/dev/null

step "6/7 Web 前端资产（语法检查 + 静态路由探活）"
WEB_OK=1
for f in web/index.html web/style.css web/app.js web/image-viewer.js web/today.js web/tasks.js web/chat.js web/summary.js web/mail.js web/pr.js web/roles.js web/system.js; do
  [ -f "$f" ] || { bad "缺文件 $f"; WEB_OK=0; }
done
for f in web/*.js; do
  # bun build 会做完整 JS 语法解析——前端脚本无 import，单文件打包等于纯解析，兜住手误
  if ! bun build "$f" --target browser --outdir /tmp/ownward-verify-web >/dev/null 2>&1; then
    bun build "$f" --target browser --outdir /tmp/ownward-verify-web 2>&1 | tail -3
    bad "$f 语法错误"; WEB_OK=0
  fi
done
rm -rf /tmp/ownward-verify-web
[ "$WEB_OK" = 1 ] && ok "web 资产完整 + JS 可解析"

step "7/7 公司属性隔离 + 上游对齐门禁（无本地配置自动跳过＝社区形态）"
# 词表在 gitignored 的 scripts/local-gates.d/company-words.txt（每行一个 ERE 片段）——
# 公开仓里连门禁自身都不能含公司字面量，所以词表永不入库；上游/社区 clone 没有它，本步自动跳过。
WORDS=scripts/local-gates.d/company-words.txt
if [ -f "$WORDS" ]; then
  # github-pr.test.ts 是隔离契约测试（断言源码不含公司词），自身合法引用词形，走排除
  if git grep -nE "$(paste -sd'|' "$WORDS")" -- src web ':!src/github-pr.test.ts' >/tmp/ownward-verify-grep.log 2>&1; then
    head -5 /tmp/ownward-verify-grep.log
    bad "公司字面量渗入 src/web（词表：scripts/local-gates.d/company-words.txt）"
  else
    ok "src/web 零公司字面量"
  fi
else
  ok "无本地公司词表，跳过公司词门禁（社区形态）"
fi
# 对齐白名单 scripts/upstream-align.txt：列内共用文件必须与 origin/main 逐字节一致。
# origin/main remote 只存在于挂了上游的集成仓；纯上游 clone 没有它，自动跳过。
ALIGN=scripts/upstream-align.txt
if [ -f "$ALIGN" ] && git rev-parse --verify -q origin/main >/dev/null 2>&1; then
  DRIFT=""
  while IFS= read -r f; do
    case "$f" in ''|\#*) continue;; esac
    git diff --quiet origin/main HEAD -- "$f" || DRIFT="$DRIFT $f"
  done < "$ALIGN"
  if [ -z "$DRIFT" ]; then
    ok "对齐白名单 $(grep -cvE '^\s*(#|$)' "$ALIGN") 文件与 origin/main 逐字节一致"
  else
    echo "      偏离文件:$DRIFT" | tr ' ' '\n' | head -8
    bad "对齐白名单偏离 origin/main——共用文件改动是「冲突决策」，要么还原要么移出白名单（有意的 A 类分叉）"
  fi
else
  ok "无 origin/main remote 或白名单，跳过对齐门禁（社区形态）"
fi

echo
if [ "$FAIL" = 0 ]; then echo "VERIFY: PASS"; exit 0; else echo "VERIFY: FAIL"; exit 1; fi
