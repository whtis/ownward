import { describe, expect, test } from "bun:test";
import { join } from "path";
import { isWithinDataDir } from "./internal-path.ts";

describe("isWithinDataDir", () => {
  const root = "/Users/test/workspace/ownward/data";

  test("识别 data 根目录和任意深度子目录", () => {
    expect(isWithinDataDir(root, root)).toBe(true);
    expect(isWithinDataDir(join(root, "chats/session-1"), root)).toBe(true);
  });

  test("不把同前缀兄弟目录误判成 data 子目录", () => {
    expect(isWithinDataDir(`${root}-backup/chats`, root)).toBe(false);
    expect(isWithinDataDir("/Users/test/workspace/ownward/database", root)).toBe(false);
  });

  test("排除 data 的父目录和普通项目目录", () => {
    expect(isWithinDataDir("/Users/test/workspace/ownward", root)).toBe(false);
    expect(isWithinDataDir("/Users/test/workspace/example", root)).toBe(false);
  });

  test("规范化点号路径，避免绕过内部目录过滤", () => {
    expect(isWithinDataDir(join(root, "chats/../tasks/one"), root)).toBe(true);
    expect(isWithinDataDir(join(root, "../project"), root)).toBe(false);
  });
});
