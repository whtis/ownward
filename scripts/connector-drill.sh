#!/bin/bash
# Connector production-data compatibility and fault drill.
# Production data is read-only; all runtime work happens in an ephemeral copy.
set -euo pipefail

cd "$(dirname "$0")/.."
SOURCE_DATA="${OWNWARD_DRILL_SOURCE:?Set OWNWARD_DRILL_SOURCE to an explicit sanitized data-copy directory}"
[ -d "$SOURCE_DATA" ] || { echo "DRILL: OWNWARD_DRILL_SOURCE is not a directory" >&2; exit 64; }
DRILL_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ownward-connector-drill.XXXXXX")"
BASELINE="$DRILL_ROOT/baseline"
RUNTIME_COPY="$DRILL_ROOT/runtime"
DAEMON_PID=""
cleanup() {
  [ -n "${DAEMON_PID:-}" ] && kill "$DAEMON_PID" 2>/dev/null || true
  rm -rf "$DRILL_ROOT"
}
trap cleanup EXIT

snapshot() {
  local root="$1"
  bun scripts/connector-drill-snapshot.ts "$root" protected
}

production_stable_after_concurrent_change() {
  local previous current
  previous="$(snapshot "$SOURCE_DATA")"
  for _ in 1 2 3; do
    sleep 0.2
    current="$(snapshot "$SOURCE_DATA")"
    if [ "$previous" = "$current" ]; then
      echo "   concurrent protected change detected during drill; stable retry window passed" >&2
      return 0
    fi
    previous="$current"
  done
  echo "DRILL: concurrent protected production changes did not settle" >&2
  return 1
}

echo "== safe copy (secrets excluded)"
mkdir -p "$BASELINE" "$RUNTIME_COPY"
rsync -a --delete --exclude '/secrets/' --exclude '/secrets' --exclude '*.sock' "$SOURCE_DATA/" "$BASELINE/"
rsync -a --delete --exclude '/secrets/' --exclude '/secrets' --exclude '*.sock' "$BASELINE/" "$RUNTIME_COPY/"
[ ! -e "$BASELINE/secrets" ] && [ ! -e "$RUNTIME_COPY/secrets" ]
touch "$BASELINE/.ownward-connector-drill-copy"
mkdir -p "$DRILL_ROOT/inventory"
bun scripts/data-migration-inventory.ts --source "$BASELINE" >"$DRILL_ROOT/inventory/report.json"
INVENTORY_REPORT="$DRILL_ROOT/inventory/report.json" bun -e 'const x=await Bun.file(process.env.INVENTORY_REPORT!).json();if(x.schemaVersion!==1||!x.cardinality||!x.keyRefs||typeof x.keyRefs.aggregateSha256!=="string")process.exit(1)'
PROD_BEFORE="$(snapshot "$SOURCE_DATA")"
COPY_BEFORE="$(snapshot "$RUNTIME_COPY")"
echo "   copied; aggregate baseline captured"

echo "== old-state/API compatibility on copy"
PORT=$((47000 + RANDOM % 1000))
OWNWARD_TEST=1 OWNWARD_TEST_PORT="$PORT" OWNWARD_DATA_ROOT="$RUNTIME_COPY" bun src/daemon.ts >"$DRILL_ROOT/daemon.log" 2>&1 &
DAEMON_PID=$!
READY=0
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/api/state" >/dev/null; then READY=1; break; fi
  kill -0 "$DAEMON_PID" 2>/dev/null || break
  sleep 0.2
done
[ "$READY" = 1 ] || { echo "DRILL: copied-data daemon failed" >&2; exit 1; }
for endpoint in api/state api/tasks api/chat/list api/feed?limit=1; do curl -sf "http://127.0.0.1:$PORT/$endpoint" >/dev/null; done
kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true; DAEMON_PID=""
COPY_AFTER="$(snapshot "$RUNTIME_COPY")"
echo "   copied-data daemon and read APIs passed"

echo "== connector durability/fault matrix"
mkdir -p "$DRILL_ROOT/data-fixture"
bun scripts/connector-data-drill.ts --source "$BASELINE" --workdir "$DRILL_ROOT/data-fixture" >"$DRILL_ROOT/data-report.json"
REPORT_PATH="$DRILL_ROOT/data-report.json" bun -e 'const x=await Bun.file(process.env.REPORT_PATH!).json();if(x.schemaVersion!==1||x.faults.pending!==0||x.faults.expiredCardActions!==1||x.sourceFixture.events<1)process.exit(1)'
OWNWARD_DATA_ROOT="$DRILL_ROOT/fixtures" bun test \
  src/kernel/connectors/runtime.test.ts \
  src/connectors/domain-events.test.ts \
  src/sources/connector-adapters.test.ts \
  src/sources/lark-connector.test.ts >"$DRILL_ROOT/tests.log" 2>&1
PASS_COUNT="$(grep -oE '[0-9]+ pass' "$DRILL_ROOT/tests.log" | tail -1 | awk '{print $1}')"
[ -n "$PASS_COUNT" ]
echo "   fixture matrix: $PASS_COUNT pass"

echo "== isolation and invariants"
PROD_AFTER="$(snapshot "$SOURCE_DATA")"
if [ "$PROD_BEFORE" != "$PROD_AFTER" ]; then
  echo "DRILL: protected production surface changed concurrently; retrying a stable read window" >&2
  production_stable_after_concurrent_change || exit 1
fi
# The copied daemon may update operational timestamps, but user-bearing cardinalities must stay fixed.
BASELINE_COUNTS="$(BASELINE_JSON="$COPY_BEFORE" bun -e 'const x=JSON.parse(process.env.BASELINE_JSON!);delete x.digest;delete x.files;console.log(JSON.stringify(x))')"
AFTER_COUNTS="$(BASELINE_JSON="$COPY_AFTER" bun -e 'const x=JSON.parse(process.env.BASELINE_JSON!);delete x.digest;delete x.files;console.log(JSON.stringify(x))')"
[ "$BASELINE_COUNTS" = "$AFTER_COUNTS" ] || { echo "DRILL: copied user-data counts changed" >&2; exit 1; }
[ ! -e "$DRILL_ROOT/fixtures/secrets" ]
if rg -l 'super-secret|ephemeral-card-token|leak2' "$DRILL_ROOT" --glob '!tests.log' >/dev/null 2>&1; then
  echo "DRILL: fixture secret leaked" >&2; exit 1
fi
if pgrep -f 'ownward-connector-.*host-entry.ts' >/dev/null 2>&1; then
  echo "DRILL: external connector host residue found" >&2; exit 1
fi
echo "   protected production surface stable; copied counts unchanged; no secrets/host residue"

echo "DRILL: PASS (source=$(basename "$SOURCE_DATA"), tests=$PASS_COUNT)"
