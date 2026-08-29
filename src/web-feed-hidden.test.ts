// web tab 显隐开关的单测：app.js 里的 tabHidden/setTabHidden/applyTabVisibility，
// 外加各接线点（tab 路由、⌘K 面板 tab 列表、初始 tab、系统 tab 的恢复开关）。
// 可隐藏 tab 目前是 feed/chat/roles，默认全隐藏，系统设置里勾选恢复。
//
// app.js / system.js 是浏览器里的普通 <script>（没有 export），照 web-feed.test.ts 的办法
// 读源码切片，用假的 localStorage / DOM 跑起来。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const app = readFileSync(join(import.meta.dir, "..", "web", "app.js"), "utf8");
const system = readFileSync(join(import.meta.dir, "..", "web", "system.js"), "utf8");

const block = app.slice(app.indexOf("/* ============ 通知流 tab"), app.indexOf("/* ============ SSE"));

/** 带假 localStorage 和假 tab 入口跑显隐代码段，取回开关三件套 */
function tabScope(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  // 每个可隐藏 tab 两个假入口（桌面 + 移动），按选择器分发
  const entries: Record<string, { style: { display: string } }[]> = { feed: [{ style: { display: "" } }, { style: { display: "" } }], chat: [{ style: { display: "" } }, { style: { display: "" } }], roles: [{ style: { display: "" } }, { style: { display: "" } }] };
  const api = Function("document", "TABS", "$$", "localStorage",
    `${block}; return { tabHidden, applyTabVisibility, setTabHidden };`)(
    { addEventListener() {} }, {}, (sel: string) => (entries[sel.match(/data-tab="(\w+)"/)?.[1] || ""] ?? []), localStorage,
  );
  return { api, store, displays: (name: string) => entries[name].map((e) => e.style.display) };
}

describe("tab 显隐开关", () => {
  test("默认全隐藏：没写过开关时 feed/chat/roles 都 display:none", () => {
    const { api, store, displays } = tabScope();
    for (const name of ["feed", "chat", "roles"]) expect(api.tabHidden(name)).toBe(true);
    api.applyTabVisibility();
    expect(displays("feed")).toEqual(["none", "none"]);
    expect(displays("chat")).toEqual(["none", "none"]);
    expect(displays("roles")).toEqual(["none", "none"]);
    expect(store.size).toBe(0);
  });

  test("显式隐藏：持久化成 1；feed 沿用旧键，chat/roles 用新键", () => {
    const { api, store, displays } = tabScope();
    api.setTabHidden("chat", true);
    expect(api.tabHidden("chat")).toBe(true);
    expect(store.get("ownward-tab-chat-hidden")).toBe("1");
    api.setTabHidden("feed", true);
    expect(store.get("ownward-feed-hidden")).toBe("1");   // 旧键不动
    expect(displays("chat")).toEqual(["none", "none"]);
  });

  test("恢复：显式设为 0，display 回空（交还给 CSS，媒体查询不受影响）", () => {
    const { api, store, displays } = tabScope();
    api.setTabHidden("roles", true);
    api.setTabHidden("roles", false);
    expect(api.tabHidden("roles")).toBe(false);
    expect(store.get("ownward-tab-roles-hidden")).toBe("0");   // 默认隐藏的时代，恢复是显式写 0
    expect(displays("roles")).toEqual(["", ""]);
    expect(api.tabHidden("feed")).toBe(true);   // 不影响其他 tab
  });

  test("刷新页面（新作用域带着旧键）状态保持", () => {
    expect(tabScope({ "ownward-feed-hidden": "1" }).api.tabHidden("feed")).toBe(true);
    expect(tabScope({ "ownward-tab-chat-hidden": "0" }).api.tabHidden("chat")).toBe(false);
    expect(tabScope({ "ownward-tab-chat-hidden": "0" }).api.tabHidden("roles")).toBe(true);
  });
});

describe("⌘K 面板的 tab 列表", () => {
  const palBlock = app.slice(app.indexOf("function palStatic()"), app.indexOf("async function palOpen"));
  // 注入的假 tabHidden 模拟真实语义：可隐藏 tab 按参数，其他 tab 恒不隐藏
  const palTabs = (hidden: boolean) => (Function("tabHidden",
    `${palBlock}; return palStatic().filter((x) => x.hint === "tab").map((x) => x.label);`)(
    (id: string) => ["feed", "chat", "roles"].includes(id) && hidden) as string[]);

  test("隐藏时过滤通知流/对话/角色，其余 tab 原样", () => {
    expect(palTabs(false).some((l) => l.includes("通知流"))).toBe(true);
    expect(palTabs(false).some((l) => l.includes("对话"))).toBe(true);
    expect(palTabs(true).some((l) => l.includes("通知流"))).toBe(false);
    expect(palTabs(true).some((l) => l.includes("对话"))).toBe(false);
    expect(palTabs(true).some((l) => l.includes("角色"))).toBe(false);
    expect(palTabs(true).some((l) => l.includes("任务"))).toBe(true);   // 不可隐藏的 tab 不受注入影响
  });
});

describe("接线点", () => {
  test("tab 路由挡住隐藏的 tab；初始 tab 落在隐藏 tab 时回今日", () => {
    expect(app).toContain("if (tabHidden(name)) return;");
    expect(app).toContain('if (tabHidden(S.tab)) S.tab = "today";');
    expect(app).toContain("applyTabVisibility();  // 隐藏时先把各 tab 入口藏掉（渲染层过滤，不动 HTML）");
  });

  test("系统 tab 有三个恢复开关并接到 setTabHidden，切换后整页重载", () => {
    for (const id of ["sy-tab-feed", "sy-tab-chat", "sy-tab-roles"]) expect(system).toContain(`id="${id}"`);
    expect(system).toContain("el.checked = !tabHidden(tab);");
    expect(system).toContain("setTabHidden(tab, !el.checked);");
    expect(system).toContain("location.reload();");   // 隐藏/显示涉及多接线点，重载保证全部生效
  });
});
