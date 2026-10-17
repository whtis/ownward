// 今天页行动卡上的 Staged Actions 渲染：徽标 / 预览 / 展开面板。
// today.js 是浏览器里的普通 <script>（没有 export），这里切出纯 HTML 生成那一段，
// 连同 app.js 的 esc/jsq/safeUrl 一起当函数体跑起来取符号。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const today = readFileSync(join(import.meta.dir, "..", "web", "today.js"), "utf8");
const app = readFileSync(join(import.meta.dir, "..", "web", "app.js"), "utf8");
const css = readFileSync(join(import.meta.dir, "..", "web", "style.css"), "utf8");
const block = today.slice(today.indexOf("const STAGE_ERR ="), today.indexOf("/* ---- Staged Actions 交互 ---- */"));
const helpers = ["const esc =", "const jsq =", "function safeUrl("].map((head) => {
  const start = app.indexOf(head);
  return app.slice(start, app.indexOf("\n", head.startsWith("function") ? app.indexOf("\n}", start) + 1 : start));
}).join("\n");

const { tdStageBadge, tdStagePreview, tdStagePanel, tdStageOutcome } = new Function(
  `${helpers}\n${block}\nreturn { tdStageBadge, tdStagePreview, tdStagePanel, tdStageOutcome };`,
)() as Record<string, (...args: any[]) => any>;

const action = (stage: any, extra: any = {}) => ({ id: "lark:oc_1", kind: "reply", source: "lark", title: "t", reason: "r", state: "open", ref: { chat_id: "oc_1" }, stage, ...extra });
const art = (extra: any = {}) => ({ v: 1, actionId: "lark:oc_1", kind: "reply_draft", body: "好的，明天给你", caveats: ["对方提到截止周五"], basis: [{ label: "群聊最近 12 条", at: "2026-10-15 10:00" }], ...extra });

describe("tdStageBadge", () => {
  test("没有 stage 不画任何东西", () => {
    expect(tdStageBadge(action(undefined))).toBe("");
  });

  test("ready：accent、可点开", () => {
    const html = tdStageBadge(action({ status: "ready" }));
    expect(html).toContain('data-tone="accent"');
    expect(html).toContain("✨ 草稿就绪");
    expect(html).toContain("toggleStage('lark:oc_1')");
    expect(html).toContain('aria-expanded="false"');
    expect(tdStageBadge(action({ status: "ready" }), true)).toContain('aria-expanded="true"');
  });

  test("stale：warn、可点开", () => {
    const html = tdStageBadge(action({ status: "stale" }));
    expect(html).toContain('data-tone="warn"');
    expect(html).toContain("⚠️ 草稿已更新");
    expect(html).toContain("toggleStage(");
  });

  test("running / queued 只是提示，不可点", () => {
    const running = tdStageBadge(action({ status: "running" }));
    expect(running).toContain("⏳ 预制中…");
    expect(running).not.toContain("onclick");
    const queued = tdStageBadge(action({ status: "queued", error: "budget" }));
    expect(queued).toContain("⏱️ 待预制");
    expect(queued).toContain("今日预制额度已用完");
    expect(queued).not.toContain("onclick");
  });

  test("failed：bad + 错误原因进 title", () => {
    const html = tdStageBadge(action({ status: "failed", error: "llm_unavailable" }));
    expect(html).toContain('data-tone="bad"');
    expect(html).toContain("预制失败");
    expect(html).toContain('title="预制失败：模型暂时不可用"');
    expect(tdStageBadge(action({ status: "failed" }))).toContain("未知原因");
  });

  test("id 里的引号不能改写 onclick 的 JS 字符串边界", () => {
    const html = tdStageBadge(action({ status: "ready" }, { id: "lark:a'b\\" }));
    expect(html).toContain("toggleStage('lark:a\\'b\\\\')");
  });
});

describe("tdStagePreview", () => {
  test("只有 ready / stale 且有 preview 才显示，并做 HTML 转义", () => {
    expect(tdStagePreview(action({ status: "ready", preview: "<b>好的</b>" }))).toBe('<div class="stage-preview">&lt;b&gt;好的&lt;/b&gt;</div>');
    expect(tdStagePreview(action({ status: "stale", preview: "x" }))).toContain("stage-preview");
    expect(tdStagePreview(action({ status: "failed", preview: "x" }))).toBe("");
    expect(tdStagePreview(action({ status: "running", preview: "x" }))).toBe("");
    expect(tdStagePreview(action({ status: "ready" }))).toBe("");
  });
});

describe("tdStagePanel", () => {
  test("读取中 / 读取失败", () => {
    expect(tdStagePanel(action({ status: "ready" }), { loading: true })).toContain("正在读取草稿");
    const err = tdStagePanel(action({ status: "ready" }), { error: "草稿读取失败" });
    expect(err).toContain("草稿读取失败");
    expect(err).toContain("重新生成");
  });

  test("飞书回复：依据、注意事项、可编辑正文、发送/重新生成/放弃", () => {
    const html = tdStagePanel(action({ status: "ready", kind: "reply_draft" }), { art: art(), text: "好的，明天给你 <3" });
    expect(html).toContain("基于：群聊最近 12 条");
    expect(html).toContain("⚠️ 注意事项：");
    expect(html).toContain("<li>对方提到截止周五</li>");
    expect(html).toContain('<textarea class="stage-text"');
    expect(html).toContain("好的，明天给你 &lt;3</textarea>");
    expect(html).toContain("tdStageSend('lark:oc_1')");
    expect(html).toContain("tdStageRegen('lark:oc_1')");
    expect(html).toContain("tdStageDiscard('lark:oc_1')");
    expect(html).not.toContain("复制意见");
  });

  test("没有 chat_id 时发送按钮禁用", () => {
    const html = tdStagePanel(action({ status: "ready" }, { ref: {} }), { art: art() });
    expect(html).toMatch(/tdStageSend\('lark:oc_1'\)" disabled/);
  });

  test("Gmail 回复：有 mail_id 才能发，按钮文案区分邮件", () => {
    const a = (ref: any) => action({ status: "ready", kind: "reply_draft" }, { id: "gmail:m1", source: "gmail", ref });
    const ok = tdStagePanel(a({ mail_id: "me@x.com:m1" }), { art: art() });
    expect(ok).toContain("发送邮件回复");
    expect(ok).not.toMatch(/tdStageSend\('gmail:m1'\)" disabled/);
    expect(tdStagePanel(a({}), { art: art() })).toMatch(/tdStageSend\('gmail:m1'\)" disabled title="缺邮件 id/);
  });

  test("stale 面板带提醒", () => {
    expect(tdStagePanel(action({ status: "stale" }), { art: art() })).toContain("草稿生成后又有新动态");
  });

  test("GitHub review：复制意见 + 打开 PR，不出现发送", () => {
    const a = action({ status: "ready", kind: "review_brief" }, { id: "gh:o/r#1", source: "github", kind: "review", ref: { url: "https://github.com/o/r/pull/1" } });
    const html = tdStagePanel(a, { art: art({ kind: "review_brief", caveats: [], basis: [] }) });
    expect(html).toContain("复制意见");
    expect(html).toContain('href="https://github.com/o/r/pull/1"');
    expect(html).toContain("打开 PR");
    expect(html).toContain("重新生成");
    expect(html).toContain("放弃草稿");
    expect(html).not.toContain("发送回复");
    expect(html).not.toContain("基于：");
    expect(html).not.toContain("注意事项");
  });

  test("非 http 链接不画「打开 PR」", () => {
    const a = action({ status: "ready", kind: "review_brief" }, { ref: { url: "javascript:alert(1)" } });
    expect(tdStagePanel(a, { art: art({ kind: "review_brief" }) })).not.toContain("打开 PR");
  });

  test("busy 时主按钮禁用，防重复发送", () => {
    const html = tdStagePanel(action({ status: "ready" }), { art: art(), busy: true });
    expect(html).toMatch(/tdStageSend\('lark:oc_1'\)" disabled/);
    expect(html).toMatch(/tdStageDiscard\('lark:oc_1'\)" disabled/);
  });
});

describe("tdStageOutcome", () => {
  test("和原稿一致（忽略首尾空白）= 原样采用，否则 = 改过", () => {
    expect(tdStageOutcome({ art: art(), text: "  好的，明天给你\n" })).toBe("sent_as_is");
    expect(tdStageOutcome({ art: art(), text: "好的，后天给你" })).toBe("edited");
  });
});

test("样式就位", () => {
  expect(css).toContain(".stage-preview");
  expect(css).toContain(".stage-panel");
});
