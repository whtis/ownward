import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { KERNEL_API_VERSION, KERNEL_VERSION } from "./contracts.ts";

const repoRoot = join(import.meta.dir, "../../..");

describe("Kernel 版本契约", () => {
  test("KERNEL_VERSION 与 package.json 一致", () => {
    // 两处不一致的话，Vertical 的 minKernelVersion 门就是拿一个假版本在比。
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(KERNEL_VERSION).toBe(pkg.version);
  });

  test("KERNEL_VERSION 是可比较的 x.y.z", () => {
    // 更新器和 minKernelVersion 都按三段数字比；带 -alpha 后缀的版本没法比大小。
    expect(KERNEL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("KERNEL_API_VERSION 是正整数", () => {
    expect(Number.isInteger(KERNEL_API_VERSION)).toBeTrue();
    expect(KERNEL_API_VERSION).toBeGreaterThan(0);
  });
});
