// 目录浏览 API 的安全边界测试：这是把文件系统列表暴露给 web 的口子，
// 逃逸 = 远程 token 持有者可枚举全盘目录结构——必须 fail closed。
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listDirs } from "./fs-browse.ts";

const base = mkdtempSync(join(tmpdir(), "fsb-"));
const root = join(base, "workspace");
const outside = join(base, "secret");
mkdirSync(join(root, "proj-a", "sub"), { recursive: true });
mkdirSync(join(root, "proj-b", ".git"), { recursive: true });
mkdirSync(join(root, ".hidden"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(root, "a-file.txt"), "x");
symlinkSync(outside, join(root, "escape-link"));
const realRoot = realpathSync(root);  // macOS 的 /var → /private/var，返回值都是归一化后的

describe("listDirs", () => {
  test("无 path 返回授权根列表", () => {
    const r = listDirs(null, [root]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entries.map((e) => e.path)).toEqual([realRoot]);
  });

  test("列出子目录：忽略文件/隐藏目录/符号链接，git 仓库有标记", () => {
    const r = listDirs(root, [root]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.name)).toEqual(["proj-a", "proj-b"]);
    expect(r.entries.find((e) => e.name === "proj-b")?.git).toBe(true);
    expect(r.parent).toBeNull(); // 就在根上，上一级回根列表视图
  });

  test("子目录的 parent 指回上一级", () => {
    const r = listDirs(join(root, "proj-a"), [root]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parent).toBe(realRoot);
  });

  test("`..` 穿越被拒：realpath 后不在根内", () => {
    const r = listDirs(join(root, "..", "secret"), [root]);
    expect(r).toMatchObject({ ok: false, msg: expect.stringContaining("授权范围") });
  });

  test("symlink 逃逸被拒：链接指向根外", () => {
    const r = listDirs(join(root, "escape-link"), [root]);
    expect(r).toMatchObject({ ok: false, msg: expect.stringContaining("授权范围") });
  });

  test("同前缀兄弟目录（workspace-evil）被拒", () => {
    const evil = root + "-evil";
    mkdirSync(evil, { recursive: true });
    expect(listDirs(evil, [root])).toMatchObject({ ok: false });
  });

  test("不存在的路径与未配置 roots 都 fail closed", () => {
    expect(listDirs(join(root, "nope"), [root])).toMatchObject({ ok: false, msg: expect.stringContaining("不存在") });
    expect(listDirs(root, [])).toMatchObject({ ok: false, msg: expect.stringContaining("allowedRoots") });
    expect(listDirs(root, [join(base, "gone")])).toMatchObject({ ok: false }); // 配置里的根全挂了
  });

  test("条数截断可见（不许静默少列）", () => {
    const many = join(base, "many");
    for (let i = 0; i < 12; i++) mkdirSync(join(many, `d${String(i).padStart(2, "0")}`), { recursive: true });
    const r = listDirs(many, [many], 10);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.entries).toHaveLength(10); expect(r.truncated).toBe(true); }
  });
});
