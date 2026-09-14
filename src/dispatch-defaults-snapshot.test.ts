import { describe, expect, test } from "bun:test";
import { homedir } from "os";
import { join } from "path";

// 派发默认目录下发前展开 `~`：/api/projects 的候选是绝对路径，目录框预填 `~/workspace` 时
// datalist 一条都匹配不上（网页「最近目录」看起来像丢了），安卓/iOS 的候选 chip 也判不出选中。
describe("dispatch defaults snapshot", () => {
  test("expands ~ in dir without touching other keys", async () => {
    const { dispatchDefaultsSnapshot } = await import("./server.ts");
    expect(dispatchDefaultsSnapshot({ dir: "~/workspace", model: "opus", permission: "bypass" }))
      .toEqual({ dir: join(homedir(), "workspace"), model: "opus", permission: "bypass" });
    expect(dispatchDefaultsSnapshot({ dir: " ~/workspace " }).dir).toBe(join(homedir(), "workspace"));
  });

  test("leaves absolute or empty dir alone and tolerates missing config", async () => {
    const { dispatchDefaultsSnapshot } = await import("./server.ts");
    expect(dispatchDefaultsSnapshot({ dir: "/srv/work" })).toEqual({ dir: "/srv/work" });
    expect(dispatchDefaultsSnapshot({ dir: "" })).toEqual({ dir: "" });
    expect(dispatchDefaultsSnapshot(undefined)).toEqual({});
    expect(dispatchDefaultsSnapshot("nope")).toEqual({});
  });
});
