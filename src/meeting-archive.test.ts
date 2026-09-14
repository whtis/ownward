import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { archiveMeetingSource, contentHash, meetingSourceHash, readMeetingArchive } from "./meeting-archive.ts";
import { meetingNotesMaterial, extractMeetingRows, renderMeetingRows } from "./meeting-notes.ts";
import { meetingSourcesDir } from "./paths.ts";

const roots: string[] = [];
async function root() { const path = await realpath(await mkdtemp(join(tmpdir(), "ownward-meetings-test-"))); roots.push(path); return path; }
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
const url = "https://example.feishu.cn/docx/test-source";
const doc = "# 08.31-09.04\n<table><tr><td>人员</td><td>本周目标</td><td>周一</td><td>周二</td></tr><tr><td>测试人员</td><td>整周背景</td><td>八月进展</td><td>九月进展</td></tr></table>";

test("归档幂等、旧版本保留、hash 随内容变化且来源可回读", async () => {
  const dir = await root();
  const first = await archiveMeetingSource(url, doc, dir);
  expect(await archiveMeetingSource(url, doc, dir)).toEqual(first);
  const second = await archiveMeetingSource(url, doc + "\n更新", dir);
  expect(second.hash).not.toBe(first.hash);
  expect(meetingSourceHash(url, dir)).toBe(second.hash);
  expect((await readMeetingArchive(url, dir))?.content).toBe(doc + "\n更新");
  expect(await readdir(join(meetingSourcesDir(undefined, dir), contentHash(url)))).toContain(`${first.hash}.md`);
});

test("并发首次归档复用目录且读不到半写原文", async () => {
  const dir = await root();
  const sources = await Promise.all(Array.from({ length: 4 }, () => archiveMeetingSource(url, doc, dir)));
  expect(new Set(sources.map((s) => s.hash)).size).toBe(1);
  expect((await readMeetingArchive(url, dir))?.content).toBe(doc);
});

test("FIFO 素材被直接拒绝，不等待写端连接", async () => {
  const dir = await root(), fifo = join(dir, "fifo");
  const p = Bun.spawnSync(["mkfifo", fifo]);
  expect(p.exitCode).toBe(0);
  const script = `import {readBoundedFile} from ${JSON.stringify(join(import.meta.dir, "meeting-archive.ts"))}; try {await readBoundedFile(${JSON.stringify(fifo)},4096); process.exit(2)} catch {process.exit(0)}`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), 2000);
  try { expect(await child.exited).toBe(0); } finally { clearTimeout(timer); }
});

test("离线使用已归档原文并显式返回过期警告", async () => {
  const dir = await root();
  await archiveMeetingSource(url, doc, dir);
  const warnings: string[] = [], sources: any[] = [];
  const text = await meetingNotesMaterial("晨会", url, ["2026-08-31"], ["测试人员"], 10_000,
    { root: dir, fetch: async () => { throw new Error("offline"); }, warnings, sources });
  expect(text).toContain("离线旧快照");
  expect(text).toContain("八月进展");
  expect(text).not.toContain("九月进展");
  expect(warnings[0]).toContain("离线旧快照");
  expect(sources[0].hash).toBe(contentHash(doc));
  expect(Object.keys(sources[0]).sort()).toEqual(["fetchedAt", "hash", "url"]);
});

test("dryRun 拉取并抽取但不创建归档，截断有持久化警告", async () => {
  const dir = await root(), warnings: string[] = [];
  const text = await meetingNotesMaterial("晨会", url, ["2026-08-31"], ["测试人员"], 10,
    { root: dir, dryRun: true, fetch: async () => doc, warnings });
  expect(await readdir(dir)).toEqual([]);
  expect(text).toContain("已截断");
  expect(warnings.join()).toContain("已截断");
});

test("目录符号链接不能把归档写出 vault", async () => {
  const dir = await root(), outside = await root();
  const sources = meetingSourcesDir(undefined, dir);
  // scope 开启时先创建 work，避免 symlink 的父目录不存在。
  const { mkdir } = await import("fs/promises");
  const { dirname } = await import("path");
  await mkdir(dirname(sources), { recursive: true });
  await symlink(outside, sources);
  await expect(archiveMeetingSource(url, doc, dir)).rejects.toThrow("符号链接");
  expect(await readdir(outside)).toEqual([]);
});

test("坏指纹、原文 symlink 和超大素材被拒绝", async () => {
  const dir = await root();
  const source = await archiveMeetingSource(url, doc, dir);
  const file = join(meetingSourcesDir(undefined, dir), contentHash(url), `${source.hash}.md`);
  await writeFile(file, "tampered");
  await expect(readMeetingArchive(url, dir)).rejects.toThrow("指纹不符");
  await rm(file);
  await symlink(join(dir, "outside"), file);
  await expect(readMeetingArchive(url, dir)).rejects.toThrow();
  await expect(archiveMeetingSource(url, "x".repeat(2 * 1024 * 1024 + 1), dir)).rejects.toThrow("上限");
});

test("跨月仅保留当月每日列；整周背景标记；合并单元格给出诊断", () => {
  const rows = extractMeetingRows(doc, ["2026-08-31"], ["测试人员"]);
  expect(rows[0].cells.map((c) => c.text)).toEqual(["整周背景", "八月进展"]);
  expect(renderMeetingRows("晨会", rows)).toContain("不可当作本月已完成事实");
  const warnings: string[] = [];
  expect(extractMeetingRows(doc.replace("<td>测试人员", '<td rowspan="2">测试人员'), ["2026-08-31"], ["测试人员"], warnings)).toEqual([]);
  expect(warnings[0]).toContain("合并单元格");
});
