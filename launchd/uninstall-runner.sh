#!/bin/bash
set -euo pipefail
LABEL="ai.ownward.runner"; PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -f "$PLIST"
echo "Runner 已卸载；journal、token 与 blob 均保留"
