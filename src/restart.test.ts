// launchctl list 输出解析：托管判断错了会让 daemon 在没人拉起的实例上自杀，值得钉死。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseLaunchdPid, takeRestartIntent, writeRestartIntent } from "./restart.ts";

const OUT = [
  "PID\tStatus\tLabel",
  "99415\t0\tcom.cloudflare.cloudflared.ownward",
  "40800\t0\tai.ownward.daemon",
  "-\t0\tai.ownward.desk-sync",
].join("\n");

describe("parseLaunchdPid", () => {
  test("取到在跑的 job 的 pid", () => {
    expect(parseLaunchdPid(OUT, "ai.ownward.daemon")).toBe(40800);
  });

  test("没在跑（pid 为 -）返回 null", () => {
    expect(parseLaunchdPid(OUT, "ai.ownward.desk-sync")).toBe(null);
  });

  test("label 不存在返回 null，不做前缀匹配", () => {
    expect(parseLaunchdPid(OUT, "ai.ownward")).toBe(null);
    expect(parseLaunchdPid(OUT, "ai.ownward.daemon.extra")).toBe(null);
  });

  test("空输出不炸", () => {
    expect(parseLaunchdPid("", "ai.ownward.daemon")).toBe(null);
  });
});

describe("restart intent", () => {
  test("只认绑定到精确 healthy generation/pid 且未过期的 intent，并且只消费一次", () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-restart-"));
    writeFileSync(join(root, "boots.json"), JSON.stringify({
      schemaVersion: 1, generation: "g1", pid: 42, startedAt: 1, healthy: true, unexpectedFailures: [],
    }));
    writeRestartIntent(root, "test", 10_000);
    expect(takeRestartIntent(root, 11_000)?.expectedGeneration).toBe("g1");
    expect(takeRestartIntent(root, 11_000)).toBe(null);
  });

  test("stale 或上一代不匹配的 intent 被丢弃，不能清 crash 计数", () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-restart-"));
    const boot = { schemaVersion: 1, generation: "g1", pid: 42, startedAt: 1, healthy: true, unexpectedFailures: [] };
    writeFileSync(join(root, "boots.json"), JSON.stringify(boot));
    writeRestartIntent(root, "test", 10_000);
    writeFileSync(join(root, "boots.json"), JSON.stringify({ ...boot, generation: "g2" }));
    expect(takeRestartIntent(root, 11_000)).toBe(null);
    writeFileSync(join(root, "boots.json"), JSON.stringify(boot));
    writeRestartIntent(root, "test", 10_000);
    expect(takeRestartIntent(root, 200_001, 120_000)).toBe(null);
  });

  test("未 healthy 的 generation 不得创建主动重启豁免", () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-restart-"));
    writeFileSync(join(root, "boots.json"), JSON.stringify({
      schemaVersion: 1, generation: "g1", pid: 42, startedAt: 1, healthy: false, unexpectedFailures: [],
    }));
    expect(() => writeRestartIntent(root, "test")).toThrow("healthy generation");
  });
});
