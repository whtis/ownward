import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// 只取 app.js 的 esc/safeUrl/mdHtml 与 notes.js 的纯函数段求值，不拉起整页
const app = readFileSync(join(import.meta.dir, "..", "web", "app.js"), "utf8");
const notes = readFileSync(join(import.meta.dir, "..", "web", "notes.js"), "utf8");
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`marker not found: ${from}`);
  return src.slice(a, b);
};
const escSrc = app.slice(app.indexOf("const esc ="), app.indexOf("\n", app.indexOf("const esc =")));
const safeUrlSrc = between(app, "function safeUrl(u)", "/** IME 组字跟踪");
const mdSrc = between(app, "function mdHtml(src)", "const hhmm =");
const pure = between(notes, "/* ==== 纯函数", "/* ==== 纯函数结束");
const nt = new Function(`${escSrc}\n${safeUrlSrc}\n${mdSrc}\n${pure}\nreturn { ntFrontmatter, ntOutline, ntToggleTask, ntResolveLink, ntJoinRel, ntRender, ntListEnter, ntListIndent, ntMark, ntStore, NT_TASK };`)() as any;

const files = [
  { path: "/v/work/projects/desk/README.md", name: "README", dir: "work/projects/desk", mtime: 3 },
  { path: "/v/work/projects/demo-app/README.md", name: "README", dir: "work/projects/demo-app", mtime: 2 },
  { path: "/v/notes/想法.md", name: "想法", dir: "notes", mtime: 1 },
  { path: "/v/notes/deep/想法.md", name: "想法", dir: "notes/deep", mtime: 0 },
];
const from = { path: "/v/work/inbox/2026-09-21.md", dir: "work/inbox" };

// 一篇把各种块型都塞进去的笔记：frontmatter、围栏里的假标题/假待办、表格、引用、有序列表、CRLF
const DOC = [
  "---", "tags:", "  - ownward", "  - 笔记", "status: \"draft\"", "---",
  "# 标题一", "- [ ] 第一件", "- [x] 第二件", "", "```md", "# 围栏里的标题", "- [ ] 围栏里的待办", "```",
  "| a | b |", "|---|---|", "| [[README|x]] | 2 |", "> - [ ] 引用里的不算", "##### 五级标题", "1. [ ] 有序待办",
  "  - [X] 缩进待办", "- [ ]", "#不是标题",
].join("\n");

describe("notes pure helpers", () => {
  test("frontmatter is folded into props and skipped by outline/tasks", () => {
    const fm = nt.ntFrontmatter(DOC);
    expect(fm.props).toEqual([["tags", "ownward, 笔记"], ["status", "draft"]]);
    expect(fm.bodyStart).toBe(6);
    expect(nt.ntFrontmatter("--- not fm\n# x").props).toBeNull();
    expect(nt.ntFrontmatter("---\nno end").props).toBeNull();
  });

  test("rendered headings and checkboxes line up 1:1 with outline and task toggling", () => {
    const html = nt.ntRender(DOC, from, files);
    const outline = nt.ntOutline(DOC);
    expect(outline.map((h: any) => [h.level, h.text])).toEqual([[1, "标题一"], [5, "五级标题"]]);
    expect([...html.matchAll(/data-h="(\d+)"/g)].map((m) => +m[1])).toEqual([0, 1]);
    const boxes = [...html.matchAll(/data-task="(\d+)"( checked)?/g)].map((m) => !!m[2]);
    expect(boxes).toEqual([false, true, false, true, false]);
    // 逐个翻转，每次只动对应那一行，围栏和引用里的不受影响
    const lines = DOC.split("\n");
    const taskLines = [7, 8, 19, 20, 21];
    taskLines.forEach((line, n) => {
      const next = nt.ntToggleTask(DOC, n).split("\n");
      expect(next.filter((l: string, i: number) => l !== lines[i]).length).toBe(1);
      expect(next[line]).not.toBe(lines[line]);
    });
    expect(nt.ntToggleTask(DOC, 0).split("\n")[7]).toBe("- [x] 第一件");
    expect(nt.ntToggleTask(DOC, 3).split("\n")[20]).toBe("  - [ ] 缩进待办");
    expect(nt.ntToggleTask(DOC, 99)).toBe(DOC);
  });

  test("CRLF files keep outline and tasks consistent and toggling preserves line endings", () => {
    const crlf = "# 一\r\n- [ ] a\r\n## 二\r\n";
    expect(nt.ntOutline(crlf).map((h: any) => h.text)).toEqual(["一", "二"]);
    expect(nt.ntToggleTask(crlf, 0)).toBe("# 一\r\n- [x] a\r\n## 二\r\n");
    expect([...nt.ntRender(crlf, from, files).matchAll(/data-h=/g)].length).toBe(2);
  });

  test("bare CR (old Mac) files line up too, and toggling keeps every line ending as it was", () => {
    const cr = "# 一\r- [ ] a\r\n## 二\n- [x] b";
    expect(nt.ntOutline(cr).map((h: any) => h.text)).toEqual(["一", "二"]);
    expect([...nt.ntRender(cr, from, files).matchAll(/data-h=/g)].length).toBe(2);
    expect([...nt.ntRender(cr, from, files).matchAll(/data-task=/g)].length).toBe(2);
    expect(nt.ntToggleTask(cr, 1)).toBe("# 一\r- [ ] a\r\n## 二\n- [ ] b");
    expect(nt.ntToggleTask(cr, 0)).toBe("# 一\r- [x] a\r\n## 二\n- [x] b");
  });

  test("wikilinks resolve like Obsidian: path suffix, name, same folder first, shortest otherwise", () => {
    expect(nt.ntResolveLink(files, "work/projects/desk/README", "x")).toBe("/v/work/projects/desk/README.md");
    expect(nt.ntResolveLink(files, "desk/readme", "x")).toBe("/v/work/projects/desk/README.md");
    expect(nt.ntResolveLink(files, "想法", "notes/deep")).toBe("/v/notes/deep/想法.md");
    expect(nt.ntResolveLink(files, "想法", "elsewhere")).toBe("/v/notes/想法.md");
    expect(nt.ntResolveLink(files, "没有这篇", "x")).toBeNull();
    expect(nt.ntJoinRel("work/inbox", "../projects/desk/README.md")).toBe("work/projects/desk/README");
  });

  test("render: links, missing links, images, code spans and escaping", () => {
    const html = nt.ntRender([
      "见 [[work/projects/demo-app/README|demo-app]] 与 [[没有这篇]] 和 [[#现状]]",
      "![[Pasted image 1.png|300]] ![外链](https://img.example.com/a.png) ![坏](javascript:alert(1))",
      "[相对](../projects/desk/README.md#现状) `[[不解析]]`",
      "https://a.com/x[[想法]]",
      "[[<img src=x onerror=alert(1)>]]",
    ].join("\n"), from, files);
    expect(html).toContain('data-note="/v/work/projects/demo-app/README.md">demo-app</a>');
    expect(html).toContain('data-missing="true" data-target="没有这篇"');
    expect(html).toContain('data-note="/v/work/inbox/2026-09-21.md" data-heading="现状">#现状</a>');
    expect(html).toContain('src="/api/vault/asset?ref=Pasted%20image%201.png&amp;from=%2Fv%2Fwork%2Finbox%2F2026-09-21.md"');
    expect(html).toContain('width="300"');
    expect(html).toContain('src="https://img.example.com/a.png"');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain('data-note="/v/work/projects/desk/README.md" data-heading="现状">相对</a>');
    expect(html).toContain("<code>[[不解析]]</code>");
    expect(html).toContain('<a href="https://a.com/x" target="_blank" rel="noopener">https://a.com/x</a><a href="#" class="nt-link"');
    expect(html).not.toContain("<img src=x");
    expect(html).not.toMatch(/[\ue000-\uf8ff]/);
  });

  test("list continuation and indentation", () => {
    const v = "- [x] done\n3. third\n- ";
    expect(nt.ntListEnter(v, 10)).toEqual({ from: 10, to: 10, text: "\n- [ ] " });
    expect(nt.ntListEnter(v, 19)).toEqual({ from: 19, to: 19, text: "\n4. " });
    expect(nt.ntListEnter(v, v.length)).toEqual({ from: 20, to: 22, text: "" });   // 空项回车 = 结束列表
    expect(nt.ntListEnter("plain", 5)).toBeNull();
    expect(nt.ntListIndent("- a", 3, false)).toEqual({ from: 0, to: 0, text: "  ", caret: 5 });
    expect(nt.ntListIndent("  - a", 5, true)).toEqual({ from: 0, to: 2, text: "", caret: 3 });
    expect(nt.ntListIndent("- a", 3, true)).toEqual({ noop: true });
    expect(nt.ntListIndent("text", 2, false)).toBeNull();
  });

  test("search highlighting escapes before marking", () => {
    expect(nt.ntMark("a <b> AB", ["ab", "<b"])).toBe("a <mark>&lt;b</mark>&gt; <mark>AB</mark>");
  });

  test("local store evicts oldest, survives corruption and reports quota failure", () => {
    const data = new Map<string, string>();
    let full = false;
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { if (full) throw new Error("quota"); data.set(k, v); } };
    const s = nt.ntStore(storage, "k", 2);
    s.set("a", { text: "1" }); s.set("b", { text: "2" }); s.set("c", { text: "3" });
    expect(s.get("a")).toBeNull();
    expect(nt.ntStore(storage, "k", 2).get("c").text).toBe("3");
    full = true;
    expect(s.set("d", { text: "4" })).toBe(false);
    data.set("k", "{");
    expect(nt.ntStore(storage, "k", 2).get("c")).toBeNull();
  });
});
