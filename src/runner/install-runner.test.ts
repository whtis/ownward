import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const sourceRoot = join(import.meta.dir, "..", "..");
function fixture(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), "ownward-runner-install-")), home = join(root, "home"), bin = join(root, "bin"), launchd = join(root, "launchd");
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true }); mkdirSync(bin); mkdirSync(launchd); mkdirSync(join(root, "src", "runner"), { recursive: true });
  writeFileSync(join(launchd, "install-runner.sh"), readFileSync(join(sourceRoot, "launchd", "install-runner.sh"))); chmodSync(join(launchd, "install-runner.sh"), 0o755);
  writeFileSync(join(launchd, "ownward-runner.plist.template"), readFileSync(join(sourceRoot, "launchd", "ownward-runner.plist.template")));
  for (const name of ["entry.ts", "server.ts", "protocol.ts", "build-identity.ts"]) writeFileSync(join(root, "src", "runner", name), readFileSync(join(sourceRoot, "src", "runner", name)));
  mkdirSync(join(root, "src", "providers"));
  const plist = join(home, "Library", "LaunchAgents", "ai.ownward.runner.plist"); writeFileSync(plist, "OLD\n");
  if (scenario === "first" || scenario === "render") unlinkSync(plist);
  const tool = (name: string, body: string) => { const file = join(bin, name); writeFileSync(file, `#!/bin/bash\n${body}\n`); chmodSync(file, 0o755); };
  tool("id", 'if [ "$1" = "-u" ]; then echo 501; else /usr/bin/id "$@"; fi'); tool("sleep", "exit 0"); tool("plutil", scenario === "render" ? 'exec /usr/bin/plutil "$@"' : "exit 0");
  tool("launchctl", `echo "$*" >> "$TEST_ROOT/launchctl.log"; n=$(($(cat "$TEST_ROOT/launch-count" 2>/dev/null || echo 0)+1)); echo "$n" > "$TEST_ROOT/launch-count"; if [ "$SCENARIO" = enable ] && [ "$1" = enable ] && [ ! -f "$TEST_ROOT/enable-failed" ]; then touch "$TEST_ROOT/enable-failed"; exit 1; fi; if [ "$SCENARIO" = bootstrap ] && [ "$1" = bootstrap ] && [ ! -f "$TEST_ROOT/bootstrap-failed" ]; then c=$(cat "$TEST_ROOT/bootstrap-count" 2>/dev/null || echo 0); c=$((c+1)); echo "$c" > "$TEST_ROOT/bootstrap-count"; if [ "$c" -le 5 ]; then [ "$c" -eq 5 ] && touch "$TEST_ROOT/bootstrap-failed"; exit 1; fi; fi; exit 0`);
  tool("bun", `if [ "$1" = -e ] || [ "$1" = src/runner/build-identity.ts ]; then exec "$REAL_BUN" "$@"; fi
echo "$*" >> "$TEST_ROOT/health-args"
[ "$SCENARIO" = concurrent ] && [ ! -f "$TEST_ROOT/concurrent-held" ] && { touch "$TEST_ROOT/concurrent-held"; /bin/sleep 0.4; }
if [ "\${2:-}" = --quiesce-control-only ]; then touch "$TEST_ROOT/draining" "$TEST_ROOT/quiesced-once"; echo '{"ok":true,"control":"quiesce"}'; exit 0; fi
if [ "\${2:-}" = --resume-control-only ]; then [ "$SCENARIO" = resumefail ] && { echo 'resume rpc failed' >&2; exit 1; }; rm -f "$TEST_ROOT/draining"; echo '{"ok":true,"control":"resume"}'; exit 0; fi
c=$(($(cat "$TEST_ROOT/health-count" 2>/dev/null || echo 0)+1)); echo "$c" > "$TEST_ROOT/health-count"; old=false; grep -q OLD "$HOME/Library/LaunchAgents/ai.ownward.runner.plist" 2>/dev/null && old=true; if $old; then build=old; else build=$("$REAL_BUN" src/runner/build-identity.ts "$TEST_ROOT"); fi; draining=false; [ -f "$TEST_ROOT/draining" ] && draining=true
base(){ if $old && [ "$SCENARIO" = legacy ]; then printf '{"ok":true,"pid":111,"draining":false,"activeRuns":[]}\n'; elif $old; then printf '{"ok":true,"pid":111,"runnerApiVersion":1,"capabilities":["quiesce","resume"],"buildIdentity":"old","draining":%s,"activeRuns":[]}\n' "$draining"; else printf '{"ok":true,"pid":222,"runnerApiVersion":1,"capabilities":["quiesce","resume"],"buildIdentity":"%s","draining":%s,"activeRuns":[]}\n' "$build" "$draining"; fi; }
case "$SCENARIO" in newprovider) if $old && printf '%s' "$*" | grep -q -- --required-provider; then echo '{"ok":false,"errorCode":"RUNNER_PROVIDER_MISSING"}'; exit 1; fi; base;; schema) echo '{"ok":true}';; schema_after_quiesce) if $draining && [ ! -f "$TEST_ROOT/schema-failed" ]; then touch "$TEST_ROOT/schema-failed"; echo '{"ok":true}'; else base; fi;; repair) if $old; then echo 'ENOENT runner.sock' >&2; exit 1; else base; fi;; health) if $old; then base; else exit 1; fi;; timeout|resumefail) if $draining; then echo '{"ok":true,"pid":111,"draining":true,"capabilities":["quiesce","resume"],"activeRuns":["held"]}'; else base; fi;; toctou) if ! $draining && [ -f "$TEST_ROOT/quiesced-once" ]; then base; elif [ "$c" -eq 1 ]; then echo '{"ok":true,"pid":111,"draining":false,"capabilities":["quiesce","resume"],"activeRuns":["a"]}'; elif [ "$c" -eq 2 ]; then echo '{"ok":true,"pid":111,"draining":true,"capabilities":["quiesce","resume"],"activeRuns":[]}'; else echo '{"ok":true,"pid":111,"draining":true,"capabilities":["quiesce","resume"],"activeRuns":["late"]}'; fi;; *) base;; esac`);
  return { root, home, bin, plist, scenario };
}
async function run(scenario: string) { const f = fixture(scenario), args = ["bash", "launchd/install-runner.sh", ...(scenario === "repair" ? ["--repair", "CONFIRM_NO_ACTIVE_RUNNER"] : [])], proc = Bun.spawn(args, { cwd: f.root, env: { ...process.env, HOME: f.home, PATH: `${f.bin}:/usr/bin:/bin`, OWNWARD_DATA_ROOT:join(f.root,"data"), OWNWARD_BUN: join(f.bin, "bun"), REAL_BUN: process.execPath, TEST_ROOT: f.root, SCENARIO: scenario }, stdout: "pipe", stderr: "pipe" }); const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]); return { ...f, code, output: out + err, plistPath: f.plist, plist: readFileSync(f.plist, "utf8") }; }
async function concurrent() { const f = fixture("concurrent"), stale = join(f.home, "Library", "LaunchAgents", ".ai.ownward.runner.install.lock"); mkdirSync(stale); writeFileSync(join(stale, "owner"), "pid=99999999\n"); const env = { ...process.env, HOME: f.home, PATH: `${f.bin}:/usr/bin:/bin`, OWNWARD_DATA_ROOT:join(f.root,"data"), OWNWARD_BUN: join(f.bin, "bun"), REAL_BUN: process.execPath, TEST_ROOT: f.root, SCENARIO: "concurrent" }, spawn = () => Bun.spawn(["bash", "launchd/install-runner.sh"], { cwd: f.root, env, stdout: "pipe", stderr: "pipe" }), a = spawn(), b = spawn(); return { codes: await Promise.all([a.exited, b.exited]), health: Number(readFileSync(join(f.root, "health-count"), "utf8")) }; }

describe("Runner installer transactional failures", () => {
  test("first install validates the new build identity", async () => { const r = await run("first"); expect(r.code, r.output).toBe(0); expect(r.plist).not.toBe("OLD\n"); });
  test("real plutil renders the exact argv array and removes every placeholder", async () => { const r = await run("render"); expect(r.code, r.output).toBe(0); const lint = Bun.spawnSync(["/usr/bin/plutil", "-lint", r.plistPath]); expect(lint.exitCode, lint.stderr.toString()).toBe(0); const converted = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", r.plistPath]); expect(converted.exitCode, converted.stderr.toString()).toBe(0); const parsed = JSON.parse(converted.stdout.toString()); expect(parsed.ProgramArguments).toEqual([join(r.bin, "bun"), "src/runner/entry.ts"]); expect(r.plist).not.toContain("__"); });
  test("healthy upgrade replaces pid/build and succeeds", async () => { const r = await run("success"); expect(r.code, r.output).toBe(0); expect(r.plist).not.toBe("OLD\n"); });
  test("legacy ping without quiesce capability upgrades only through two zero-active checks", async () => { const r = await run("legacy"); expect(r.code, r.output).toBe(0); expect(Number(readFileSync(join(r.root, "health-count"), "utf8"))).toBeGreaterThanOrEqual(3); });
  test("explicit repair audits a proven unreachable Runner before reinstall", async () => { const r = await run("repair"); if (r.code !== 0) throw new Error(`${r.root}\n${r.output || "no output"}`); expect(readFileSync(join(r.root, "data", "runner-repair-audit.log"), "utf8")).toContain("repair-confirmed"); });
  test("新启用的 provider 不被升级前探针强求（旧 Runner 按旧配置启动，尚未注册它）", async () => {
    const r = await run("newprovider");
    expect(r.code, r.output).toBe(0);
    expect(r.plist).not.toBe("OLD\n");
    const calls = readFileSync(join(r.root, "health-args"), "utf8").trim().split("\n").filter((l) => l.includes("health.ts"));
    // 升级前的连通/drain 探针不带 provider 门；重启后的严格门仍然要带（否则等于取消了这道验收）
    expect(calls.some((l) => l.includes("--required-provider"))).toBeTrue();
    expect(calls[0]).not.toContain("--required-provider");
  });
  test("invalid health schema fails before mutation", async () => { const r = await run("schema"); expect(r.code).toBe(65); expect(r.plist).toBe("OLD\n"); expect(r.output).toContain("schema"); });
  test("enable failure restores and health-checks the previous definition", async () => { const r = await run("enable"); expect(r.code).not.toBe(0); expect(r.plist).toBe("OLD\n"); expect(r.output).toContain("restoring previous"); });
  test("bootstrap exhaustion restores the previous definition", async () => { const r = await run("bootstrap"); expect(r.code).not.toBe(0); expect(r.plist).toBe("OLD\n"); expect(r.output).toContain("restoring previous"); });
  test("new health deadline failure restores a healthy previous definition", async () => { const r = await run("health"); expect(r.code).not.toBe(0); expect(r.plist).toBe("OLD\n"); expect(r.output).toContain("restoring previous"); }, 10_000);
  test("quiesce TOCTOU gate refuses a late active command before plist mutation", async () => { const r = await run("toctou"); expect(r.code).toBe(75); expect(r.plist).toBe("OLD\n"); expect(r.output).toContain("重新出现 active run"); });
  test("drain timeout resumes the old Runner before returning", async () => { const r = await run("timeout"); expect(r.code).toBe(75); expect(r.plist).toBe("OLD\n"); expect(readFileSync(join(r.root, "health-args"), "utf8")).toContain("--resume"); },10_000);
  test("resume RPC failure is fatal and diagnosed as failed recovery", async () => { const r = await run("resumefail"); expect(r.code).toBe(70); expect(r.output).toContain("failed to resume previous Runner"); },10_000);
  test("schema failure after quiesce automatically resumes the previous Runner", async () => { const r = await run("schema_after_quiesce"); expect(r.code).toBe(65); const calls = readFileSync(join(r.root, "health-args"), "utf8"); expect(calls).toContain("--quiesce-control-only"); expect(calls).toContain("--resume-control-only"); expect(() => readFileSync(join(r.root, "draining"))).toThrow(); });
  test("two concurrent stale-lock recoverers allow at most one past health/quiesce", async () => { const r = await concurrent(); expect(r.codes.filter((c) => c === 0)).toHaveLength(1); expect(r.codes.filter((c) => c === 75)).toHaveLength(1); expect(r.health).toBeGreaterThan(0); });
});
