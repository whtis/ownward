// SKILL_APPROVAL_INTERACTIVE_REQUIRED 原本把四个前提塌成一句话，用户看到报错也不知道该动什么
// （2026-09-03 实测：点恢复报这个，而且 toast 还被 showModal 的弹窗盖住，连报错都看不见）。
import { expect, test } from "bun:test";
import { browserApprovalDenial, isBrowserApprovalRequest } from "../server.ts";
import { readFileSync } from "fs";
import { join } from "path";

const cookie = `ownward_ui_session=${"a".repeat(64)}`;
const req = (h: Record<string, string>) => new Request("http://127.0.0.1:4517/api/skills/x", { method: "POST", headers: h });

test("每一条前提失败都给出可操作的具体原因", () => {
  expect(browserApprovalDenial(req({}))).toContain("cookie");
  expect(browserApprovalDenial(req({ cookie }))).toContain("Origin");
  expect(browserApprovalDenial(req({ cookie, origin: "http://127.0.0.1:4517" }))).toContain("Sec-Fetch-Site");
  expect(browserApprovalDenial(req({ cookie, origin: "http://localhost:4517", "sec-fetch-site": "same-origin" })))
    .toContain("daemon 看到的是");                                    // 换地址访问这种最难猜的情况要点破
  expect(browserApprovalDenial(req({ cookie, origin: "http://127.0.0.1:4517", "sec-fetch-site": "same-origin" }))).toBeNull();
  expect(isBrowserApprovalRequest(req({ cookie, origin: "http://127.0.0.1:4517", "sec-fetch-site": "same-origin" }))).toBe(true);
});

test("toast 进 top layer，否则永远被模态弹窗盖住", () => {
  const app = readFileSync(join(import.meta.dir, "..", "..", "web", "app.js"), "utf8");
  expect(app).toContain("showPopover");                              // z-index 盖不过 top layer，只能同样进 top layer
  for (const page of ["index.html", "strategy.html"]) {
    const html = readFileSync(join(import.meta.dir, "..", "..", "web", page), "utf8");
    expect(html).toMatch(/id="toast"[^>]*popover="manual"|popover="manual"[^>]*id="toast"/);
  }
});
