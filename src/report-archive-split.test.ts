import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { archiveMeetingSource, readMeetingArchive, type MeetingSource } from "./meeting-archive.ts";
import { meetingNotesMaterial } from "./meeting-notes.ts";

const url = "https://example.feishu.cn/docx/archive-split-test";
const doc = "# 0831-0904\n<table><tr><th>人员</th><th>周一</th><th>周二</th></tr><tr><td>Blair 李四</td><td>八月完成</td><td>九月完成</td></tr></table>";

test("月报取材缺归档时直接失败，不联网或创建归档", async () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-report-archive-"));
  let requests = 0;
  try {
    await expect(meetingNotesMaterial("晨会", url, ["2026-08-31"], ["李四"], 30_000, {
      root, archive: false, fetch: async () => { requests++; return doc; },
    })).rejects.toThrow("归档");
    expect(requests).toBe(0);
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("归档后可离线取材，月报和试运行均不刷新版本或调用来源", async () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-report-archive-"));
  let requests = 0;
  try {
    const original = await archiveMeetingSource(url, doc, root);
    for (const dryRun of [false, true]) {
      const sources: MeetingSource[] = [];
      const text = await meetingNotesMaterial("晨会", url, ["2026-08-31"], ["李四"], 30_000, {
        root, archive: false, dryRun, sources, fetch: async () => { requests++; throw new Error("不应联网"); },
      });
      expect(text).toContain("八月完成");
      expect(text).not.toContain("九月完成");
      expect(sources).toEqual([original]);
      expect(sources[0]).not.toHaveProperty("content");
      const saved = await readMeetingArchive(url, root);
      expect(saved?.hash).toBe(original.hash);
      expect(saved?.fetchedAt).toBe(original.fetchedAt);
    }
    expect(requests).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("归档存在但没有对应人员或日期时，不伪装成完整月报素材", async () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-report-archive-"));
  try {
    await archiveMeetingSource(url, doc, root);
    await expect(meetingNotesMaterial("晨会", url, ["2026-08-31"], ["不存在"], 30_000, { root, archive: false })).rejects.toThrow("可用条目");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
