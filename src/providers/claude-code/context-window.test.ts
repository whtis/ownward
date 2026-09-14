import { describe, expect, test } from "bun:test";
import { contextWindowOf } from "./context-window.ts";

describe("contextWindowOf：result.modelUsage → 主循环模型窗口", () => {
  const usage = { "claude-haiku-4-5": { contextWindow: 200_000 }, "claude-opus-5": { contextWindow: 1_000_000 } };
  test("命中候选模型就用它的窗口，哪怕别的桶更大（haiku 主模型 + opus 子代理）", () => {
    expect(contextWindowOf(usage, ["claude-haiku-4-5"])).toBe(200_000);
    expect(contextWindowOf(usage, [undefined, "claude-opus-5"])).toBe(1_000_000);
  });
  test("候选都不命中（别名 / 旧 CLI 只报聚合桶）退回最大值", () => {
    expect(contextWindowOf(usage, ["opus"])).toBe(1_000_000);
    expect(contextWindowOf(usage)).toBe(1_000_000);
  });
  test("没有字段 / 形状不对 / 非正数 → 0，调用方按模型名兜底", () => {
    expect(contextWindowOf(undefined)).toBe(0);
    expect(contextWindowOf([])).toBe(0);
    expect(contextWindowOf({ a: { contextWindow: "1000000" }, b: { contextWindow: -1 }, c: null })).toBe(0);
    expect(contextWindowOf({ a: {} }, ["a"])).toBe(0);
  });
});
