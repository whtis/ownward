#!/bin/bash
# Ownward 一键安装：检查依赖 → 生成本机配置 → 安装常驻 daemon。
# 幂等：重复跑不覆盖已有的 config.json / prompts/owner.md，只重装 daemon。
set -euo pipefail
cd "$(dirname "$0")"
. launchd/lib-msg.sh

# ── 1. 依赖检查 ──────────────────────────────────────────────
[ "$(uname)" = "Darwin" ] || { msg "❌ Ownward currently supports macOS only (launchd service + system notifications)" "❌ 目前只支持 macOS（launchd 常驻 + 系统通知）"; exit 1; }
command -v bun >/dev/null || { msg "❌ Bun is required: curl -fsSL https://bun.sh/install | bash" "❌ 需要 bun：curl -fsSL https://bun.sh/install | bash"; exit 1; }
command -v git >/dev/null || { msg "❌ Git is required (included with the Xcode Command Line Tools: xcode-select --install)" "❌ 需要 git（Xcode Command Line Tools 自带）"; exit 1; }
# claude 是默认决策引擎但不是硬前置：llm.engine 可切 codex，领域 Vertical 也可使用自己的决策链。
command -v claude >/dev/null || command -v codex >/dev/null || {
  msg "⚠ Neither claude nor codex was found. The daemon will start, but AI features such as triage and heartbeat won't work." \
      "⚠ 没找到 claude 也没找到 codex——daemon 能起,但分流/心跳等 AI 功能会失灵。";
  msg "  Install one: npm i -g @anthropic-ai/claude-code (default) or npm i -g @openai/codex (then set llm.engine to codex in config.json)" \
      "  装其一:npm i -g @anthropic-ai/claude-code(默认)或 npm i -g @openai/codex(config 里 llm.engine 切 codex)";
}

# ── 2. 本机配置（只在首装时询问；之后改 config.json 即可） ──
if [ ! -f config.json ]; then
  OWNER_NAME=""
  VAULT_ROOT="~/Documents/ownward-vault"
  if [ -t 0 ]; then
    read -r -p "$(msg "What should Ownward call you? (used in notifications and drafts; optional)" "你的称呼（通知/文档草稿里怎么称呼你，可留空）"): " OWNER_NAME || true
    read -r -p "$(msg "Vault directory for work logs and notes (press Enter for ${VAULT_ROOT})" "vault 目录（工作日志与笔记落盘处，回车用默认 ${VAULT_ROOT}）"): " V || true
    [ -n "${V:-}" ] && VAULT_ROOT="$V"
  fi
  # 交给 JSON.stringify 序列化：手拼 heredoc 时反斜杠/控制字符会产出非法 JSON
  OWNER_NAME="$OWNER_NAME" VAULT_ROOT="$VAULT_ROOT" bun -e '
    const cfg = { owner: { name: process.env.OWNER_NAME || "" }, vault: { root: process.env.VAULT_ROOT || "~/Documents/ownward-vault" } };
    await Bun.write("config.json", JSON.stringify(cfg, null, 2) + "\n");
  '
  msg "✅ Created config.json (local overrides, never committed; see config.default.json for every option)" "✅ config.json 已生成（本机覆盖层，永不进 git；全部可配项见 config.default.json）"
else
  msg "· config.json already exists; skipping config generation" "· config.json 已存在，跳过配置生成"
fi

# 旧 config 没有 allowedRoots 时安全补齐：只授权 Ownward 仓库的父目录，绝不退化成任意路径。
# 显式 [] 视为用户选择的禁用状态，不覆盖。
bun scripts/config-bootstrap.ts "$(pwd)/config.json" "$(pwd)" >/dev/null

if [ ! -f prompts/owner.md ]; then
  NAME_LINE="$(grep -o '"name": *"[^"]*"' config.json | head -1 | sed 's/.*: *"\(.*\)"/\1/' || true)"
  cat > prompts/owner.md <<EOF
# Owner 画像（个人，不进 git）

- 称呼：${NAME_LINE:-（未填写）}
- 这段会前置注入所有后台决策（triage/heartbeat/日报/routine 草稿）的 system prompt。
- 照 prompts/owner.example.md 的结构补充角色、重要/不重要的事、文风——写得越准，通知分级越像你自己判断的。
EOF
  msg "✅ Created prompts/owner.md (fill in your profile following prompts/owner.example.md)" "✅ prompts/owner.md 已生成（按 owner.example.md 补充画像）"
fi

# ── 3. 安装 CLI ──────────────────────────────────────────────
CLI_DIR="$HOME/.local/bin"
mkdir -p "$CLI_DIR"
for CLI_NAME in own; do
  CLI_TARGET="$(pwd)/bin/$CLI_NAME"
  CLI_LINK="$CLI_DIR/$CLI_NAME"
  if [ ! -e "$CLI_LINK" ] && [ ! -L "$CLI_LINK" ]; then
    ln -s "$CLI_TARGET" "$CLI_LINK"
    msg "✅ Installed command: $CLI_LINK" "✅ 已安装命令：${CLI_LINK}"
  elif [ -L "$CLI_LINK" ] && [ "$(readlink "$CLI_LINK")" = "$CLI_TARGET" ]; then
    msg "· Command already installed: $CLI_LINK" "· 命令已存在：${CLI_LINK}"
  else
    msg "⚠ Left an existing command in place: $CLI_LINK (you can still run bin/$CLI_NAME directly)" "⚠ 未覆盖已有命令：${CLI_LINK}（仍可直接使用 bin/${CLI_NAME}）"
  fi
done

# ── 4. 以一个不可变 release 事务切换 Runner + daemon ─────────
# 任一协议、schema、build identity、观察窗或真实 Provider canary 失败，成对恢复旧定义。
: "${OWNWARD_OBSERVATION_SEC:=120}"
: "${OWNWARD_PROVIDER_CANARY:=1}"
export OWNWARD_OBSERVATION_SEC OWNWARD_PROVIDER_CANARY
[ "$OWNWARD_OBSERVATION_SEC" != 0 ] && [ "$OWNWARD_PROVIDER_CANARY" != 0 ] || msg "⚠ break-glass: release observation/provider canary explicitly disabled" "⚠ break-glass: release observation/provider canary 被显式关闭" >&2
bash launchd/install-release.sh

echo
msg "🚀 Ownward is installed. Web workbench: http://127.0.0.1:4517" "🚀 装好了。Web 工作台：http://127.0.0.1:4517"
msg "   CLI: own status" "   CLI：own status"
msg "   If your shell can't find own, add ~/.local/bin to your PATH" "   若 shell 找不到 own，请把 ~/.local/bin 加入 PATH"
msg "   Lark / Gmail / GitHub / stock sources are off by default; see docs/configuration.md to enable them" "   飞书 / Gmail / GitHub / 股票默认关闭，开启方法见 docs/configuration.md"
