import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const app = readFileSync(join(import.meta.dir, "..", "web", "app.js"), "utf8");
const tasks = readFileSync(join(import.meta.dir, "..", "web", "tasks.js"), "utf8");
const chat = readFileSync(join(import.meta.dir, "..", "web", "chat.js"), "utf8");
const block = app.slice(app.indexOf("const ComposerDrafts ="), app.indexOf("/* ============ 全局状态") );

function drafts(seed = "") {
  const data = new Map(seed ? [["ownward-composer-drafts-v1", seed]] : []);
  const sessionStorage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) };
  const scope: any = {};
  const api = Function("sessionStorage", "globalThis", `${block}; return globalThis.ComposerDrafts`)(sessionStorage, scope);
  return { api, raw: () => data.get("ownward-composer-drafts-v1") || "" };
}

describe("composer drafts", () => {
  test("A/B/A text and attachments remain isolated", () => {
    const { api } = drafts();
    api.setText("task:A", "alpha"); api.setAttachments("task:A", [{ data: "a" }]);
    api.setText("task:B", "beta"); api.setAttachments("task:B", [{ data: "b" }]);
    expect(api.getText("task:A")).toBe("alpha");
    expect(api.getAttachments("task:A")).toEqual([{ data: "a" }]);
    expect(api.getText("task:B")).toBe("beta");
  });

  test("text rebuilds from versioned sessionStorage but attachments never persist", () => {
    const first = drafts();
    first.api.setText("chat:x", "reload me"); first.api.setAttachments("chat:x", [{ data: "secret" }]);
    expect(first.raw()).toContain('"version":1');
    expect(first.raw()).not.toContain("secret");
    const second = drafts(first.raw());
    expect(second.api.getText("chat:x")).toBe("reload me");
    expect(second.api.getAttachments("chat:x")).toEqual([]);
  });

  test("corrupt or wrong-version storage fails closed and text is bounded", () => {
    expect(drafts("{").api.getText("x")).toBe("");
    expect(drafts('{"version":2,"entries":{"x":{"text":"old"}}}').api.getText("x")).toBe("");
    const { api } = drafts(); api.setText("x", "a".repeat(25_000));
    expect(api.getText("x")).toHaveLength(20_000);
    for (let i = 0; i < 100; i++) api.setText(`task:${i}`, String(i));
    expect(Array.from({ length: 100 }, (_, i) => api.getText(`task:${i}`)).filter(Boolean)).toHaveLength(80);
  });

  test("clear models successful send while failure keeps the original identity", () => {
    const { api } = drafts();
    api.setText("chat:A", "retry"); api.setAttachments("chat:A", [{ data: "pic" }]);
    expect(api.getText("chat:A")).toBe("retry"); // failed request leaves it
    api.clearText("chat:A"); api.setAttachments("chat:A", []);
    expect(api.getText("chat:A")).toBe(""); expect(api.getAttachments("chat:A")).toEqual([]);
    api.setText("chat:A", "newer"); api.clearText("chat:A", "older");
    expect(api.getText("chat:A")).toBe("newer");
  });

  test("new chat identity can migrate without overwriting an existing destination", () => {
    const { api } = drafts();
    api.setText("chat:new", "new"); api.setAttachments("chat:new", [{ data: "n" }]);
    api.moveText("chat:new", "chat:id"); api.moveAttachments("chat:new", "chat:id");
    expect(api.getText("chat:id")).toBe("new"); expect(api.getAttachments("chat:id")).toEqual([{ data: "n" }]);
    expect(api.getText("chat:new")).toBe("");
  });

  test("call sites capture async attachment and send identities", () => {
    expect(tasks).toContain('const key = Tasks.sel ? `task:${Tasks.sel}` : "";');
    expect(tasks).toContain('if (Tasks.sel && `task:${Tasks.sel}` === key)');
    expect(chat).toContain("const key = chatDraftKey();");
    expect(chat).toContain("if (chatDraftKey() === key)");
    expect(chat).toContain("bindComposer(ci, { key: chatDraftKey, send: sendChat });");
    expect(chat).toContain("const sendKey = chatDraftKey();");
    expect(chat).toContain("if (chatDraftKey() === sendKey)");
    expect(chat).toContain('composerSent(createdId ? `chat:${createdId}` : sendKey, text);');
    expect(chat).toContain("bindChatImages(ci);\n    restoreChatComposer();");
  });

  test("stream painter never mutates another chat DOM and follows chat:new migration", () => {
    const start = chat.indexOf("function chatSendOwnsView");
    const end = chat.indexOf("/** 只取绑定详情", start);
    let current = "chat:A", selected: string | null = "A";
    const paints: string[] = [];
    const api = Function("chatDraftKey", "Chat", "renderChatMsgs", `${chat.slice(start, end)}; return {chatSendOwnsView,paintChatSend}`)(
      () => current, { get sel() { return selected; } }, (partial: string) => paints.push(partial),
    );
    expect(api.paintChatSend("chat:A", "", "A1")).toBeTrue();
    current = "chat:B"; selected = "B";
    expect(api.paintChatSend("chat:A", "", "A2")).toBeFalse();
    expect(paints).toEqual(["A1"]);
    current = "chat:new"; selected = null;
    expect(api.paintChatSend("chat:new", "", "N1")).toBeTrue();
    current = "chat:made"; selected = "made";
    expect(api.paintChatSend("chat:new", "made", "N2")).toBeTrue();
    current = "chat:B"; selected = "B";
    expect(api.paintChatSend("chat:new", "made", "N3")).toBeFalse();
    expect(paints).toEqual(["A1", "N1", "N2"]);
  });

  test("composer history reads the active identity bucket", () => {
    const start = app.indexOf('const HIST_KEY =');
    const end = app.indexOf('/* Composer 草稿', start);
    const data = new Map<string, string>();
    const localStorage = { getItem: (k: string) => data.get(k) || null, setItem: (k: string, v: string) => data.set(k, v) };
    const listeners: Record<string, Function> = {};
    const menu: any = { hidden: true, innerHTML: "", querySelector: () => null };
    const host: any = { querySelector: () => null, prepend: () => {} };
    const el: any = {
      value: "", selectionStart: 0, selectionEnd: 0, parentElement: host,
      closest: () => host, addEventListener: (name: string, fn: Function) => (listeners[name] = fn),
      dispatchEvent: (event: any) => listeners[event.type]?.(event), setSelectionRange(a: number, b: number) { this.selectionStart = a; this.selectionEnd = b; },
      focus() {},
    };
    let key = "chat:A";
    const api = Function("localStorage", "document", "Event", `${app.slice(start, end)}; return {bindComposer,composerSent}`)(
      localStorage, { createElement: () => menu }, class { constructor(public type: string) {} },
    );
    api.bindComposer(el, { key: () => key, send() {} });
    api.composerSent("chat:A", "from A"); api.composerSent("chat:B", "from B");
    const up = () => listeners.keydown({ key: "ArrowUp", isComposing: false, shiftKey: false, preventDefault() {} });
    up(); expect(el.value).toBe("from A");
    key = "chat:B"; el.value = ""; el.selectionStart = el.selectionEnd = 0;
    up(); expect(el.value).toBe("from B");
  });

  test("successful settlement clears the exact raw snapshot, not its trimmed payload", () => {
    const { api } = drafts();
    const raw = "  hello  ";
    api.setText("task:A", raw);
    api.clearText("task:A", raw.trim());
    expect(api.getText("task:A")).toBe(raw);
    api.clearText("task:A", raw);
    expect(api.getText("task:A")).toBe("");
    api.setText("chat:A", raw); // user edits while the old request is in flight
    api.setText("chat:A", "new draft");
    api.clearText("chat:A", raw);
    expect(api.getText("chat:A")).toBe("new draft");
    expect(tasks).toContain("ComposerDrafts.clearText(key, draftSnapshot)");
    expect(chat).toContain("ComposerDrafts.clearText(sendKey, draftSnapshot)");
  });
});
