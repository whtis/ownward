import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyNotePref, buildLinkIndex, findBacklinks, joinRel, notePrefsView, readNotePrefs, resolveVaultAsset,
  saveVaultNote, scanVault, searchVault, wikiTarget, writeNotePrefs, RECENT_CAP,
} from "./vault-notes.ts";

let root = "", outside = "";
const put = (rel: string, text: string | Buffer, mtimeSec?: number) => {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
  if (mtimeSec) utimesSync(full, mtimeSec, mtimeSec);
  return full;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ownward-vault-notes-"));
  outside = mkdtempSync(join(tmpdir(), "ownward-vault-outside-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("scanVault", () => {
  test("indexes markdown by mtime, skips hidden dirs, indexes images by lowercase basename", () => {
    put("old.md", "# old", 1_000);
    put("work/projects/a/README.md", "# a", 3_000);
    put(".obsidian/workspace.md", "hidden");
    put("Pasted Image 1.PNG", "png");
    put("attachments/Pasted Image 1.png", "png");
    put("notes/x.svg", "<svg/>");
    const { files, assets } = scanVault(root);
    expect(files.map((f) => [f.name, f.dir])).toEqual([["README", "work/projects/a"], ["old", ""]]);
    expect(assets.get("pasted image 1.png")).toEqual([join(root, "Pasted Image 1.PNG"), join(root, "attachments/Pasted Image 1.png")]);
    expect(assets.has("x.svg")).toBe(false);
  });

  test("missing vault root is an empty index, not an error", () => {
    expect(scanVault(join(root, "nope")).files).toEqual([]);
  });
});

describe("searchVault", () => {
  test("all terms must hit (name or body); name hits rank first; snippets carry line numbers", () => {
    put("daily/2026-09-20.md", "早上\n和 Alice 讨论了 Ownward 笔记页\n下午写代码", 3_000);
    put("ownward/笔记页设计.md", "搜索 + 最近打开", 2_000);
    put("misc.md", "Ownward only", 1_000);
    const r = searchVault(scanVault(root).files, "ownward 笔记");
    expect(r.hits.map((h) => h.name)).toEqual(["笔记页设计", "2026-09-20"]);
    expect(r.hits[1].matches).toEqual([{ line: 1, text: "和 Alice 讨论了 Ownward 笔记页" }]);
    expect(r.total).toBe(2);
    expect(r.truncated).toBe(false);
  });

  test("cached bodies are revalidated by mtime: edits show up, deleted files drop out", () => {
    const f = put("a.md", "old words", 1_000);
    expect(searchVault(scanVault(root).files, "old").total).toBe(1);
    put("a.md", "new words", 2_000);
    const files = scanVault(root).files;
    expect(searchVault(files, "old").total).toBe(0);
    expect(searchVault(files, "new").total).toBe(1);
    rmSync(f);
    expect(searchVault(scanVault(root).files, "new").total).toBe(0);
  });

  test("limit truncates observably instead of silently", () => {
    for (let i = 0; i < 5; i++) put(`n${i}.md`, "needle");
    const r = searchVault(scanVault(root).files, "needle", 2);
    expect(r.hits.length).toBe(2);
    expect(r.total).toBe(5);
    expect(r.truncated).toBe(true);
  });

  test("blank query returns nothing", () => {
    put("a.md", "x");
    expect(searchVault(scanVault(root).files, "   ").hits).toEqual([]);
  });
});

describe("backlinks", () => {
  test("wikilinks by name, by path suffix and relative md links all count; self links do not", () => {
    const target = put("work/projects/desk/README.md", "# desk\n[[README]] 自己", 5_000);
    put("work/inbox/2026-09-20.md", "- 改了 [[work/projects/desk/README|desk]]\n- 又提到 [[projects/desk/README#现状]]", 4_000);
    put("private/log.md", "见 [说明](../work/projects/desk/README.md)", 3_000);
    put("work/projects/other/README.md", "[[work/projects/desk/README]] 和 [[work/projects/desk/README]]", 2_000);
    put("unrelated.md", "[[work/projects/other/README]]", 1_000);
    const { files } = scanVault(root);
    const hits = findBacklinks(buildLinkIndex(files), files, files.find((f) => f.path === target)!);
    expect(hits.map((h) => h.path)).toEqual([
      join(root, "work/inbox/2026-09-20.md"), join(root, "private/log.md"), join(root, "work/projects/other/README.md"),
    ]);
    expect(hits[0].matches.map((m) => m.line)).toEqual([0, 1]);
    expect(hits[2].matches.length).toBe(1);   // 同一行链两次只记一次
  });

  test("link target normalisation", () => {
    expect(wikiTarget("Work/Projects/Desk/README.md#现状|desk")).toBe("work/projects/desk/readme");
    expect(wikiTarget("#只是页内标题")).toBe("");
    expect(joinRel("a/b", "../c/d%20e.md")).toBe("a/c/d e");
    expect(joinRel("a", "../../x.md")).toBeNull();
  });
});

describe("resolveVaultAsset", () => {
  test("note dir first, then vault root, then by file name anywhere", () => {
    const note = put("work/projects/a/README.md", "");
    put("work/projects/a/img/shot.png", "near");
    put("img/shot.png", "root");
    put("attachments/Pasted image 1.png", "far");
    const { assets } = scanVault(root);
    expect(resolveVaultAsset(root, assets, "img/shot.png", note)?.path).toBe(join(root, "work/projects/a/img/shot.png"));
    expect(resolveVaultAsset(root, assets, "img/shot.png")?.path).toBe(join(root, "img/shot.png"));
    expect(resolveVaultAsset(root, assets, "Pasted%20image%201.png|300", note)).toEqual({ path: join(root, "attachments/Pasted image 1.png"), type: "image/png" });
  });

  test("refuses traversal, non-images, svg, hidden dirs and symlinks that leave the vault", () => {
    const note = put("n.md", "");
    writeFileSync(join(outside, "secret.png"), "x");
    put("x.svg", "<svg onload=alert(1)>");
    put(".trash/old.png", "x");
    put("n2.md", "not an image");
    symlinkSync(join(outside, "secret.png"), join(root, "link.png"));
    const { assets } = scanVault(root);
    expect(resolveVaultAsset(root, assets, `../${outside.split("/").pop()}/secret.png`, note)).toBeNull();
    expect(resolveVaultAsset(root, assets, "x.svg", note)).toBeNull();
    expect(resolveVaultAsset(root, assets, ".trash/old.png", note)).toBeNull();
    expect(resolveVaultAsset(root, assets, "n2.md", note)).toBeNull();
    expect(resolveVaultAsset(root, assets, "link.png", note)).toBeNull();
    expect(resolveVaultAsset(root, assets, "a\0.png", note)).toBeNull();
  });
});

describe("saveVaultNote", () => {
  test("writes when the base version still matches and reports the new mtime", () => {
    const f = put("a.md", "v1", 1_000);
    const base = statSync(f).mtimeMs;
    const r = saveVaultNote(f, "v2", base);
    expect(r.ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("v2");
    expect(r.ok && r.mtime).toBe(statSync(f).mtimeMs);
  });

  test("refuses to overwrite a file changed elsewhere, and reports a deleted one", () => {
    const f = put("a.md", "v1", 1_000);
    const base = statSync(f).mtimeMs;
    put("a.md", "harvest appended", 2_000);
    const r = saveVaultNote(f, "mine", base);
    expect(r).toEqual({ ok: false, code: "VAULT_CONFLICT", mtime: statSync(f).mtimeMs });
    expect(readFileSync(f, "utf8")).toBe("harvest appended");
    expect(saveVaultNote(join(root, "gone.md"), "x", 1)).toEqual({ ok: false, code: "VAULT_GONE" });
  });

  test("without a base version the user's explicit overwrite goes through (and recreates folders)", () => {
    const f = join(root, "new/dir/a.md");
    expect(saveVaultNote(f, "mine").ok).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("mine");
  });
});

describe("note prefs", () => {
  test("open moves to the front, dedupes and caps; pin/unpin toggles", () => {
    let p = { recent: [], pinned: [] } as ReturnType<typeof readNotePrefs>;
    for (let i = 0; i < RECENT_CAP + 5; i++) p = applyNotePref(p, "open", `n${i}`, new Date(i * 1000));
    p = applyNotePref(p, "open", "n10", new Date(99_000));
    expect(p.recent.length).toBe(RECENT_CAP);
    expect(p.recent[0]).toEqual({ rel: "n10", at: new Date(99_000).toISOString() });
    expect(p.recent.filter((r) => r.rel === "n10").length).toBe(1);
    p = applyNotePref(applyNotePref(applyNotePref(p, "pin", "a"), "pin", "b"), "pin", "a");
    expect(p.pinned).toEqual(["a", "b"]);
    expect(applyNotePref(p, "unpin", "a").pinned).toEqual(["b"]);
  });

  test("round-trips through disk, tolerates corruption, hides notes that no longer exist", () => {
    const file = join(root, "data/notes-prefs.json");
    expect(readNotePrefs(file)).toEqual({ recent: [], pinned: [] });
    writeNotePrefs(file, { recent: [{ rel: "a", at: "2026-09-21T00:00:00.000Z" }, { rel: "gone", at: "x" }], pinned: ["a"] });
    const back = readNotePrefs(file);
    expect(back.recent.length).toBe(2);
    put("a.md", "");
    expect(notePrefsView(root, back)).toEqual({
      ok: true, recent: [{ path: join(root, "a.md"), at: "2026-09-21T00:00:00.000Z" }], pinned: [join(root, "a.md")],
    });
    writeFileSync(file, "{");
    expect(readNotePrefs(file)).toEqual({ recent: [], pinned: [] });
  });
});
