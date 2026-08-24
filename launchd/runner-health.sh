#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
launchctl print "gui/$(id -u)/ai.ownward.runner" | grep -E "state|pid"
BUN="${OWNWARD_BUN:-$(command -v bun || true)}"
[ -n "$BUN" ] && [ -x "$BUN" ] || { echo "❌ 找不到可执行 bun"; exit 1; }
"$BUN" src/runner/health.ts
