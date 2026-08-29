// 功能开关：data/features.json 持久化，默认全开；系统设置页每个 checkbox 对应一个键。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { featureFlags, setFeature, FEATURE_DEFAULTS } from "./features.ts";

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), "ownward-features-"));
  return { dir, file: join(dir, "features.json") };
}

describe("featureFlags", () => {
  test("文件不存在 → 默认全开", () => {
    const { dir, file } = tmpFile();
    try {
      expect(featureFlags(file)).toEqual({ capture: true, digest: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("文件坏了 → 默认全开；缺键 → 该键回落默认", () => {
    const { dir, file } = tmpFile();
    try {
      writeFileSync(file, "not json{{{");
      expect(featureFlags(file)).toEqual(FEATURE_DEFAULTS);
      writeFileSync(file, JSON.stringify({ capture: false }));
      expect(featureFlags(file)).toEqual({ capture: false, digest: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("setFeature 持久化显式 false，再读回来保持；未知键抛错", () => {
    const { dir, file } = tmpFile();
    try {
      const flags = setFeature("digest", false, file);
      expect(flags.digest).toBe(false);
      expect(featureFlags(file).digest).toBe(false);
      setFeature("digest", true, file);
      expect(featureFlags(file).digest).toBe(true);
      expect(() => setFeature("nope" as any, true, file)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
