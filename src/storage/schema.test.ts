import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  SchemaCompatibilityError,
  LEGACY_ROLLBACK_SCHEMA_VERSION,
  assertLegacyRollbackCompatible,
  ensureCompatibleSchema,
  readCompatibleSchema,
  schemaFile,
} from "./schema.ts";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ownward-schema-"));
  roots.push(root);
  return root;
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("data schema gate", () => {
  test("legacy 数据只读检查兼容且不写文件", () => {
    const root = tempRoot();
    expect(readCompatibleSchema(root)).toBeNull();
    expect(readdirSync(root)).toEqual([]);
  });

  test("幂等初始化 schema 1 并保留既有数据", () => {
    const root = tempRoot();
    writeFileSync(join(root, "tasks.json"), "[]");
    expect(ensureCompatibleSchema(root)).toEqual({ version: 1, applied: [] });
    expect(ensureCompatibleSchema(root)).toEqual({ version: 1, applied: [] });
    expect(JSON.parse(readFileSync(schemaFile(root), "utf8"))).toEqual({ version: 1, applied: [] });
    expect(readFileSync(join(root, "tasks.json"), "utf8")).toBe("[]");
    expect(readdirSync(root).some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  test("未来 schema fail closed 且不改文件", () => {
    const root = tempRoot();
    const raw = '{"version":2,"applied":["future"]}\n';
    writeFileSync(schemaFile(root), raw);
    expect(() => ensureCompatibleSchema(root)).toThrow(SchemaCompatibilityError);
    expect(readFileSync(schemaFile(root), "utf8")).toBe(raw);
    expect(readdirSync(root)).toEqual(["schema.json"]);
  });

  test("daemon 测试模式也在任何运行时写入前拒绝未来 schema", () => {
    const root = tempRoot();
    const raw = '{"version":2,"applied":[]}\n';
    writeFileSync(schemaFile(root), raw);
    const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "daemon.ts")], {
      cwd: join(import.meta.dir, "..", ".."),
      env: { ...process.env, OWNWARD_TEST: "1", OWNWARD_DATA_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(78);
    expect(proc.stderr.toString()).toContain("高于当前程序支持");
    expect(readFileSync(schemaFile(root), "utf8")).toBe(raw);
    expect(readdirSync(root)).toEqual(["schema.json"]); // pid/boots/logs/life 均未产生
  });

  test("损坏或形状错误的 schema 拒绝启动", () => {
    for (const raw of ["{", '{}', '{"version":0}', '{"version":1,"applied":[1]}']) {
      const root = tempRoot();
      writeFileSync(schemaFile(root), raw);
      expect(() => readCompatibleSchema(root)).toThrow(SchemaCompatibilityError);
      expect(existsSync(schemaFile(root))).toBe(true);
    }
  });

  test("无 gate 的 last-good 回滚判据钉死 schema 1，不跟随当前支持上限", () => {
    expect(LEGACY_ROLLBACK_SCHEMA_VERSION).toBe(1);
    const cases: Array<[string | null, boolean]> = [
      [null, true],
      ['{"version":1,"applied":[]}', true],
      ['{"version":2,"applied":[]}', false],
      ["{", false],
    ];
    for (const [raw, allowed] of cases) {
      const root = tempRoot();
      if (raw !== null) writeFileSync(schemaFile(root), raw);
      const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "schema.ts"), "--check-legacy", root], {
        stdout: "pipe", stderr: "pipe",
      });
      expect(proc.exitCode === 0).toBe(allowed);
      if (allowed) expect(() => assertLegacyRollbackCompatible(root)).not.toThrow();
      else expect(() => assertLegacyRollbackCompatible(root)).toThrow(SchemaCompatibilityError);
    }
  });
});
