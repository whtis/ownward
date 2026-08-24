// 投影层「控制台内容完整性」专测：message-completed/provider-notice/session-updated 的
// 完整展开。回归背景：原投影只取 body.text，thinking/工具行/工具报错/codex 命令执行/
// 限流提示全被丢——「web 会话比终端少内容」的根源。
import { describe, expect, test } from "bun:test";
import { RunnerAgentStateProjector, toolBrief } from "./runner-consumer.ts";

const session: any = { id: "s1", providerId: "claude", control: "ownward" };
function project(events: { type: string; body?: unknown; commandKind?: string }[], providerId = "claude") {
  const payloads = new Map<string, unknown>();
  const p = new RunnerAgentStateProjector({ ...session, providerId } as any, (e: any) => payloads.get(e.eventId), (id) => ({ kind: "start-run" }) as any);
  events.forEach((e, i) => {
    const eventId = `e${i}`;
    if (e.body !== undefined) payloads.set(eventId, e.body);
    p.apply({ eventId, sequence: i + 1, type: e.type, at: `2026-08-20T00:00:0${i}.000Z`, commandId: "c1", runId: "r1", sessionId: "s1", providerId, ...(e.body !== undefined ? { payloadRef: `payloads/${"0".repeat(64)}.blob` } : {}) } as any);
  });
  return p.state();
}

describe("RunnerAgentStateProjector 消息展开", () => {
  test("assistant 帧展开 thinking + 正文 + 工具行（legacy push 形状）", () => {
    const s = project([{ type: "message-completed", body: { role: "assistant", text: "结论", thinking: ["先想一下"], tools: [{ id: "t1", name: "Bash", input: { command: "ls -la" } }] } }]);
    expect(s.messages.map((m: any) => m.role)).toEqual(["thinking", "assistant", "tool"]);
    expect(s.messages[2]).toMatchObject({ name: "Bash", text: "ls -la" });
  });

  test("纯工具轮（text 为空）不再整条消失", () => {
    const s = project([{ type: "message-completed", body: { role: "assistant", text: "", thinking: [], tools: [{ id: "t1", name: "Read", input: { file_path: "/a/b.ts" } }] } }]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ role: "tool", name: "Read" });
  });

  test("工具报错 payload（无 text 字段）透出为 ⚠️ 出错", () => {
    const s = project([{ type: "message-completed", body: { role: "tool", error: true, content: ["boom: exit 1"] } }]);
    expect(s.messages[0]).toMatchObject({ role: "tool", name: "⚠️ 出错", text: "boom: exit 1" });
  });

  test("成功工具结果（tool-result payload）逐条展开并带名字", () => {
    const s = project([{ type: "message-completed", body: { role: "tool-result", results: [{ name: "Bash", content: "total 8\ndrwxr-xr-x" }] } }]);
    expect(s.messages[0]).toMatchObject({ role: "tool", name: "↳ Bash" });
    expect(s.messages[0].text).toContain("total 8");
  });

  test("provider-notice 透出：限流/压缩中/压缩失败", () => {
    const s = project([
      { type: "provider-notice", body: { category: "rate_limited", message: "hit limit" } },
      { type: "provider-notice", body: { category: "compacting" } },
      { type: "provider-notice", body: { category: "compact_failed", error: "no" } },
    ]);
    expect(s.messages.map((m: any) => m.text)).toEqual(["⚠️ 撞到限流：hit limit", "⏳ 正在压缩上下文（/compact）…", "⚠️ 压缩失败：no"]);
    expect(s.messages[0]).toMatchObject({ role: "system", name: "error" });
  });

  test("session-updated 带出 commands/model；request 级 usage 带出 ctxTokens（turn 级不覆盖）", () => {
    const s = project([
      { type: "session-updated", body: { nativeRef: "n1", model: "claude-example-5", commands: ["compact", "clear"] } },
      { type: "usage", body: { scope: "request", inputTokens: 1200, outputTokens: 5, contextTokens: 1200 } },
      { type: "usage", body: { scope: "turn", inputTokens: 99999, outputTokens: 50, contextTokens: 99999 } },
    ]);
    expect(s.commands).toEqual(["compact", "clear"]);
    expect(s.model).toBe("claude-example-5");
    expect(s.ctxTokens).toBe(1200);
  });

  test("tokens 出 legacy 别名：turn 级累计 input/output/total（web token pill 与安卓面板都读旧键）", () => {
    const s = project([
      { type: "usage", body: { scope: "turn", inputTokens: 100, outputTokens: 20 } },
      { type: "usage", body: { scope: "turn", inputTokens: 50, outputTokens: 5 } },
    ]);
    expect(s.tokens).toMatchObject({ input: 150, output: 25, total: 175 });
  });

  test("审批卡兼容投影：question 重建 legacy 形状（toolName/brief/input.questions），tool 补 brief", () => {
    const s = project([
      { type: "approval-requested", body: { kind: "question", question: "走哪边？", options: ["左", "右"] } },
      { type: "approval-requested", body: { kind: "tool", toolName: "Bash", input: { command: "git push" } } },
    ]);
    const [q, t] = s.pending as any[];
    expect(q).toMatchObject({ kind: "question", toolName: "AskUserQuestion", question: "走哪边？" });
    expect(q.brief).toContain("走哪边？");
    expect(q.input.questions[0].options).toEqual([{ label: "左" }, { label: "右" }]);
    expect(t).toMatchObject({ toolName: "Bash", brief: "Bash: git push" });
  });

  test("codex 命令执行/文件改动/搜索/思考/计划全部投影", () => {
    const s = project([
      { type: "message-completed", body: { role: "tool", type: "command_execution", item: { command: "bun test", aggregated_output: "3 pass", exit_code: 0 } } },
      { type: "message-completed", body: { role: "tool", type: "file_change", item: { changes: [{ kind: "edit", path: "src/a.ts" }] } } },
      { type: "message-completed", body: { role: "tool", type: "web_search", item: { query: "bun docs" } } },
      { type: "message-completed", body: { role: "thinking", type: "reasoning", item: { text: "想一下" } } },
      { type: "message-completed", body: { role: "plan", type: "todo_list", item: { items: [{ text: "步骤一", completed: false }] } } },
    ], "codex");
    expect(s.messages.map((m: any) => [m.role, m.name ?? ""])).toEqual([["tool", "$"], ["tool", "✎ 文件"], ["tool", "🔎 搜索"], ["thinking", ""]]);
    expect(s.messages[0].text).toBe("bun test\n3 pass");
    expect(s.plan).toEqual([{ text: "步骤一", status: "pending" }]);  // 归一化成 legacy {text,status}
  });

  test("codex 非零退出码标注 (exit N)", () => {
    const s = project([{ type: "message-completed", body: { role: "tool", type: "command_execution", item: { command: "false", aggregated_output: "", exit_code: 1 } } }], "codex");
    expect(s.messages[0].text).toBe("false\n(exit 1)");
  });

  test("旧 payload（纯 text 字符串）仍按 assistant 渲染——历史 journal 兼容", () => {
    const s = project([{ type: "message-completed", body: "老格式文本" }]);
    expect(s.messages[0]).toMatchObject({ role: "assistant", text: "老格式文本" });
  });

  test("toolBrief 摘要字段优先级", () => {
    expect(toolBrief({ command: "ls   -la" })).toBe("ls -la");
    expect(toolBrief({ file_path: "/x" })).toBe("/x");
    expect(toolBrief(null)).toBe("");
  });
});

// 图片可见：tool-result 的 images URL 透传（只放行自家仓路径），无文本纯图也要成行
describe("tool-result 图片投影", () => {
  test("带图结果透传 URL；纯图结果出 name=image 行；非法 URL 被滤", () => {
    const s = project([{ type: "message-completed", body: { role: "tool-result", results: [
      { name: "Bash", content: "done", images: ["/api/agent-image/s1/aaaaaaaaaaaaaaaa.png"] },
      { name: "Read", content: "", images: ["/api/agent-image/s1/bbbbbbbbbbbbbbbb.jpg", "https://evil.example/x.png"] },
      { name: "空的", content: "", images: [] },
    ] } }]);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]).toMatchObject({ role: "tool", name: "↳ Bash", images: ["/api/agent-image/s1/aaaaaaaaaaaaaaaa.png"] });
    expect(s.messages[1]).toMatchObject({ role: "tool", name: "image", text: "🖼 图片 ×1", images: ["/api/agent-image/s1/bbbbbbbbbbbbbbbb.jpg"] });
  });
});

// 分类表查不到就静默丢弃，是「有真错误却什么都不显示」的直接成因（2026-08-24：lock_conflict
// 不在表里，用户只看到「失败 1」，而真错误一直躺在 payload blob 里）。
describe("notice 分类不许被吞", () => {
  test("锁冲突透出可操作提示", () => {
    const s = project([{ type: "provider-notice", body: { category: "lock_conflict", tail: "already has an active writer" } }]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].text).toContain("already has an active writer");
    expect(s.messages[0].text).toContain("终端");
    expect(s.messages[0].name).toBe("error");
  });
  test("表里没有的分类原样透出，不静默丢弃", () => {
    const s = project([{ type: "provider-notice", body: { category: "brand_new_failure_mode", tail: "провал" } }]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].text).toContain("brand_new_failure_mode");
    expect(s.messages[0].text).toContain("провал");
  });
  test("未知分类且无任何详情才允许沉默（没内容可给用户看）", () => {
    expect(project([{ type: "provider-notice", body: { category: "empty_unknown" } }]).messages).toHaveLength(0);
  });
});

// notice 噪音治理：空详情 api_error 是旧 adapter 误标的 status 帧（历史 journal 里还有），不许渲染
describe("notice 渲染边界", () => {
  test("空详情 api_error 跳过；带详情的照常透出", () => {
    const s = project([
      { type: "provider-notice", body: { category: "api_error" } },
      { type: "provider-notice", body: { category: "api_error", message: "500 upstream" } },
    ]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].text).toBe("⚠️ 500 upstream");
  });
  test("压缩成功显 ✅ 且不带 error 标记", () => {
    const s = project([{ type: "provider-notice", body: { category: "compact_ok" } }]);
    expect(s.messages[0]).toMatchObject({ role: "system", text: "✅ 上下文已压缩" });
    expect(s.messages[0].name).toBeUndefined();
  });
});
