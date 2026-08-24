#!/bin/bash
# Claude Code 会话上报钩子：只装在 ownward 派发的 terminal 任务上（--settings 局部注入，
# 不碰用户全局 ~/.claude/settings.json）。SessionStart 把 session_id/transcript_path 直接
# 告诉 daemon，terminal 任务的会话链接从「扫 transcript 猜」变成 claude 自己报的事实；
# SessionEnd 让任务立刻收尾，不用等 15 分钟沉寂兜底。
#
# 纪律（借鉴 raft wake 契约）：上报失败必须静默降级，绝不打扰用户的会话——
#   · 永远 exit 0（非 0 会被 Claude Code 当成阻断信号）
#   · stdout 一个字都不写（SessionStart 的 stdout 会被注入进模型上下文）
#   · 超时上限 3s，daemon 没在跑就当无事发生
set -u

TASK_ID="${OWNWARD_TASK_ID:-}"
[ -n "$TASK_ID" ] || exit 0

PORT="${OWNWARD_PORT:-4517}"
LAUNCH_ID="${OWNWARD_ADOPT_LAUNCH_ID:-}"
TOKEN_FILE="${OWNWARD_ADOPT_TOKEN_FILE:-}"
TOKEN=""
[ -n "$TOKEN_FILE" ] && TOKEN="$(sed -n '1p' -- "$TOKEN_FILE" 2>/dev/null || true)"

# curl 的 header 参数会出现在进程 argv；握手 token 只通过 stdin config 传入。
# hook JSON 先落 0600 临时文件，避免 stdin 同时承担 config 与 payload。
PAYLOAD="$(mktemp "${TMPDIR:-/tmp}/ownward-cc-hook.XXXXXX")" || exit 0
chmod 600 "$PAYLOAD" 2>/dev/null || { rm -f "$PAYLOAD"; exit 0; }
trap 'rm -f "$PAYLOAD"' EXIT
cat >"$PAYLOAD" || exit 0
{
  printf '%s\n' 'header = "Content-Type: application/json"'
  [ -n "$LAUNCH_ID" ] && printf 'header = "X-Ownward-Adopt-Launch: %s"\n' "$LAUNCH_ID"
  [ -n "$TOKEN" ] && printf 'header = "X-Ownward-Adopt-Token: %s"\n' "$TOKEN"
} | curl -s -m 3 -X POST --config - \
  "http://127.0.0.1:${PORT}/api/cc-hook?taskId=${TASK_ID}" \
  --data-binary "@$PAYLOAD" >/dev/null 2>&1

exit 0
