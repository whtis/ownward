import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { helperLabel, renderHelperPlist } from "./deploy-helper.ts";

describe("deploy helper", () => {
  test("一次性 job：RunAtLoad=true KeepAlive=false，且不使用 nohup/submit", () => {
    const p = renderHelperPlist("ai.ownward.deploy.x", "/tmp/root", "restart", [], "/tmp/x.log", "/custom/bun/bin/bun");
    expect(p).toContain("<key>RunAtLoad</key><true/>");
    expect(p).toContain("<key>KeepAlive</key><false/>");
    expect(p).not.toContain("nohup");
    expect(p).not.toContain("launchctl submit");
    expect((p.match(/deploy-helper\.sh/g) || []).length).toBe(1);
    expect(p).toContain("<key>OWNWARD_BUN</key><string>/custom/bun/bin/bun</string>");
    // PATH 必须带用户级 bin（claude/codex 在 ~/.local/bin）——缺了 provider canary 会被静默跳过
    const home = process.env.HOME || "";
    expect(p).toContain(`<key>PATH</key><string>/custom/bun/bin:${home}/.local/bin:${home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>`);
  });

  test("唯一 label 只含 launchd 安全字符", () => {
    expect(helperLabel("Apply A/B_1")).toBe("ai.ownward.deploy.apply-a-b-1");
  });

  test("apply 必须等待完整 release transaction 回执，之后才清理 worktree/push", () => {
    const sh = readFileSync(join(import.meta.dir, "..", "scripts", "deploy-helper.sh"), "utf8");
    const install = sh.indexOf('OWNWARD_EVOLVE_ATTEMPT_ID="$ATTEMPT_ID"');
    expect(sh).toContain("bash launchd/install-release.sh");
    expect(sh).toContain("scripts/deploy-result.ts");
    expect(sh).toContain('COMMITTED_BUILD=');
    expect(sh).toContain('[ "$COMMITTED_BUILD" != "$EXPECTED_BUILD" ]');
    expect(sh).toContain('OWNWARD_EXPECTED_BUILD="$EXPECTED_BUILD"');
    expect(install).toBeGreaterThan(0);
    expect(sh.indexOf("git worktree remove", install)).toBeGreaterThan(install);
    expect(sh.indexOf("git push origin main", install)).toBeGreaterThan(install);
    expect(sh).not.toMatch(/(^|\s)bun\s+src\//m);
  });

  test("rollback 脚本拒绝 daemon/CLI 直接执行", () => {
    const sh = readFileSync(join(import.meta.dir, "..", "scripts", "rollback.sh"), "utf8");
    expect(sh).toContain('[ "${1:-}" != "--helper" ]');
    expect(sh).toContain("OWNWARD_TARGET_RELEASE_ID");
    expect(sh).toContain("install-release.sh");
    expect(sh).not.toContain("git reset --hard");
  });
});
