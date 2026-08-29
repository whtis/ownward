// 系统设置里邮件源显隐开关的单测：localStorage 读写 + system.js 开关接线 + mail.js 消费。
// 模式照 web-feed-hidden.test.ts：读源码切片，假 localStorage 跑函数。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const mail = readFileSync(join(import.meta.dir, "..", "web", "mail.js"), "utf8");
const system = readFileSync(join(import.meta.dir, "..", "web", "system.js"), "utf8");

/** 抽 mail.js 里源显隐三函数跑起来，取回 API 和假 localStorage */
function mailScope(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  const block = mail.slice(mail.indexOf("/* ---- 源切换"), mail.indexOf("/* ---- 账号"));
  const api = Function("localStorage", "$", `${block}; return { mailSourceVisible, setMailSourceVisible };`)(localStorage, () => null);
  return { api, store };
}

describe("邮件源显隐偏好", () => {
  test("默认两个源都可见（localStorage 无记录）", () => {
    const { api } = mailScope();
    expect(api.mailSourceVisible("gmail")).toBe(true);
    expect(api.mailSourceVisible("outlook")).toBe(true);
  });

  test("隐藏：写 localStorage 键；恢复：删键", () => {
    const { api, store } = mailScope();
    api.setMailSourceVisible("outlook", false);
    expect(store.get("ownward-mail-outlook-hidden")).toBe("1");
    expect(api.mailSourceVisible("outlook")).toBe(false);
    expect(api.mailSourceVisible("gmail")).toBe(true); // 不影响另一个源
    api.setMailSourceVisible("outlook", true);
    expect(store.has("ownward-mail-outlook-hidden")).toBe(false);
    expect(api.mailSourceVisible("outlook")).toBe(true);
  });

  test("预置隐藏键时读取生效", () => {
    const { api } = mailScope({ "ownward-mail-gmail-hidden": "1" });
    expect(api.mailSourceVisible("gmail")).toBe(false);
    expect(api.mailSourceVisible("outlook")).toBe(true);
  });
});

describe("系统设置接线", () => {
  test("界面区块有两个源开关", () => {
    expect(system).toContain('id="sy-mail-gmail"');
    expect(system).toContain('id="sy-mail-outlook"');
  });

  test("开关绑定：回显 mailSourceVisible、变更写 setMailSourceVisible、立即同步 mail tab", () => {
    expect(system).toContain("el.checked = mailSourceVisible(src);");
    expect(system).toContain("setMailSourceVisible(src, el.checked);");
    expect(system).toContain("syncMailSourceVisibility();");
  });
});
