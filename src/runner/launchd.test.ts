import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

describe("Runner launchd 生命周期隔离", () => {
  test("runner job 是独立 KeepAlive，顶层 installer 先升级 Runner 再重启 daemon", () => {
    const root = join(import.meta.dir, "..", "..");
    const template = readFileSync(join(root, "launchd", "ownward-runner.plist.template"), "utf8");
    expect(template).toContain("ai.ownward.runner"); expect(template).toContain("src/runner/entry.ts"); expect(template).toContain("OWNWARD_DATA_ROOT"); expect(template).toContain("OWNWARD_RUNNER_BUILD_IDENTITY"); expect(template).toMatch(/<key>KeepAlive<\/key><true\/>/);
    const runnerInstall = readFileSync(join(root, "launchd", "install-runner.sh"), "utf8"); expect(runnerInstall).toContain("set -euo pipefail"); expect(runnerInstall).toContain("activeRuns"); expect(runnerInstall).toContain("--repair"); expect(runnerInstall).toContain("--quiesce"); expect(runnerInstall).toContain("--resume"); expect(runnerInstall).toContain("BUILD_IDENTITY"); expect(runnerInstall).toContain("launchctl enable"); expect(runnerInstall).toContain("restoring previous launchd definition"); expect(runnerInstall).not.toContain("launchctl print");
    const daemonInstall = readFileSync(join(root, "launchd", "install.sh"), "utf8").split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    expect(daemonInstall).toContain("parseSessionMigrationMode"); expect(daemonInstall).toContain("validateSessionRunnerTaskIds"); expect(daemonInstall).not.toContain("ai.ownward.runner"); expect(daemonInstall).not.toContain("install-runner");
    const topInstall = readFileSync(join(root, "install.sh"), "utf8"), releaseInstall=readFileSync(join(root,"launchd","install-release.sh"),"utf8");
    expect(topInstall).toContain("bash launchd/install-release.sh");
    expect(releaseInstall.indexOf("install-runner.sh")).toBeLessThan(releaseInstall.indexOf('install.sh"'));
    expect(releaseInstall).toContain("restore_marker");
    expect(releaseInstall).toMatch(/bootout \"\$DOMAIN\/ai\.ownward\.daemon\"[^]*bootstrap_plist ai\.ownward\.runner[^]*runner_probe[^]*bootstrap_plist ai\.ownward\.daemon/);
    expect(topInstall).toContain("不可变 release 事务");
    for (const file of ["src/restart.ts", "src/deploy-helper.ts"]) expect(readFileSync(join(root, file), "utf8")).not.toMatch(/launchctl[^\n]*(?:bootout|kickstart)[^\n]*ai\.ownward\.runner/);
    // 锚定 /data/：只忽略仓库根的运行时数据目录——裸 data/ 会把 android 源码的 data 包一起吞
    expect(readFileSync(join(root, ".gitignore"), "utf8").split("\n")).toContain("/data/");
  });
});
