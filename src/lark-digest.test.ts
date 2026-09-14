import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("日报仅取勾选私聊，原始群聊保留，重收割保留取消状态，空的当天不回退", async () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-lark-digest-test-"));
  try {
    const modulePath = join(import.meta.dir, "lark-digest.ts");
    const script = `
      const { saveLarkDaily, selectedLarkForDigest, larkDailyFor, toggleLarkMsg } = await import(${JSON.stringify(modulePath)});
      const { cfg } = await import(${JSON.stringify(join(import.meta.dir, "util.ts"))});
      cfg.timezone = "Asia/Shanghai";
      const msg = (id, chat_type) => ({ id, chat_id: id, chat_type, chat_name: id, sender: "test", ts: 1, text: id, selected: true });
      const rows = [msg("direct", "p2p"), msg("group", "group"), msg("unchecked", "p2p"), msg("unknown", "")];
      saveLarkDaily("2026-09-07", rows);
      toggleLarkMsg("2026-09-07", "unchecked", false);
      saveLarkDaily("2026-09-07", rows);
      const selected = selectedLarkForDigest("2026-09-07").map(m => m.id);
      const fallback = selectedLarkForDigest("2026-09-08").map(m => m.id);
      const stored = larkDailyFor("2026-09-07").map(m => m.id);
      saveLarkDaily("2026-09-08", []);
      console.log(JSON.stringify({ selected, fallback, stored, empty: selectedLarkForDigest("2026-09-08") }));
    `;
    const env: NodeJS.ProcessEnv = { ...process.env, OWNWARD_DATA_ROOT: root, OWNWARD_CONFIG_ROOT: root, OWNWARD_SOURCE_ROOT: join(import.meta.dir, "..") };
    delete env.OWNWARD_BUILD_IDENTITY;
    const child = Bun.spawn([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    const result = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(result.selected).toEqual(["direct"]);
    expect(result.fallback).toEqual(["direct"]);
    expect(result.stored).toEqual(["direct", "group", "unchecked", "unknown"]);
    expect(result.empty).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
