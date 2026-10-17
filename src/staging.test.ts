import { test, expect, describe } from "bun:test";
import type { Action, ActionStage, StageArtifact } from "./actions.ts";
import {
  STAGING_DEFAULTS, checkDailyBudget, computeInputSig, gatherGithubReview, gatherGmailReply, gatherLarkReply, isActionEligible,
  parseMailRef, parsePrRef, recoverOrphanedRunning, recoverOrphanedStages, runStaging, stagingConfig, type StagingDeps,
} from "./staging.ts";

const NOW = new Date("2026-10-15T06:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const cfgOn = { ...STAGING_DEFAULTS, enabled: true };

function act(over: Partial<Action> = {}): Action {
  return {
    id: "lark:oc_1", kind: "reply", source: "lark", title: "回复 张三", reason: "私聊最后一条来自对方",
    state: "open", createdAt: minsAgo(30), updatedAt: minsAgo(30), ref: { chat_id: "oc_1" }, ...over,
  };
}
const stage = (status: ActionStage["status"], over: Partial<ActionStage> = {}): ActionStage =>
  ({ status, kind: "reply_draft", attempt: 1, updatedAt: minsAgo(30), ...over });

/** 内存版 actions 存储：语义照抄 actions.ts（活对象引用、终态拒写、inputSig CAS） */
function store(rows: Action[]) {
  const writes: { id: string; stage: ActionStage }[] = [];
  const listActions = (includeDone = true) => rows.filter((a) => includeDone || a.state === "open" || a.state === "snoozed");
  const setActionStage = (id: string, s: ActionStage, expect?: { inputSig?: string }) => {
    const cur = rows.find((x) => x.id === id);
    if (!cur || cur.state === "resolved" || cur.state === "dismissed") return false;
    if (expect?.inputSig && cur.stage?.inputSig && cur.stage.inputSig !== expect.inputSig) return false;
    cur.stage = s; writes.push({ id, stage: { ...s } });
    return true;
  };
  return { rows, writes, listActions, setActionStage };
}

const larkOk = JSON.stringify({ data: { messages: [
  { message_id: "m2", create_time: String(NOW.getTime() - 60_000), sender: { id: "ou_a", name: "张三" }, content: '{"text":"明天能评审吗？"}' },
  { message_id: "m1", create_time: String(NOW.getTime() - 120_000), sender: { id: "ou_me" }, content: '{"text":"在吗"}' },
] } });

function harness(rows: Action[], over: Partial<StagingDeps> = {}) {
  const s = store(rows), state: any = {}, artifacts: StageArtifact[] = [], prompts: string[] = [];
  const deps: StagingDeps = {
    config: cfgOn, now: () => NOW, engine: "claude",   // 全量传入，不受本机 config.json 的 staging 影响
    listActions: s.listActions as any, setActionStage: s.setActionStage,
    saveArtifact: (a) => artifacts.push(a),
    loadState: () => state, updateState: (mut) => mut(state),
    readPrompt: (f) => `PROMPT:${f}`,
    llm: async (p) => { prompts.push(p); return { body: "可以，明天下午三点？", preview: "约明天下午", caveats: ["时间待确认"], basis: [{ label: "2 条消息", at: "t" }] }; },
    gather: {
      myLarkId: "ou_me",
      runCommand: async () => ({ code: 0, stdout: larkOk, stderr: "" }),
      prDetail: async () => { throw new Error("unused"); }, prDiff: async () => "",
    },
    ...over,
  };
  return { ...s, state, artifacts, prompts, deps };
}

describe("isActionEligible", () => {
  test("settleMin 门槛：刚好到点才算", () => {
    expect(isActionEligible(act({ createdAt: minsAgo(9.9) }), cfgOn, NOW)).toBeFalse();
    expect(isActionEligible(act({ createdAt: minsAgo(10) }), cfgOn, NOW)).toBeTrue();
    expect(isActionEligible(act({ createdAt: minsAgo(1) }), { ...cfgOn, settleMin: 0 }, NOW)).toBeTrue();
  });
  test("只认配置里的 source.kind", () => {
    expect(isActionEligible(act({ kind: "review", source: "github" }), cfgOn, NOW)).toBeTrue();
    expect(isActionEligible(act({ kind: "decide", source: "system" }), cfgOn, NOW)).toBeFalse();
    expect(isActionEligible(act({ kind: "reply", source: "gmail" }), cfgOn, NOW)).toBeTrue();
    expect(isActionEligible(act({ kind: "reply", source: "gmail" }), { ...cfgOn, kinds: ["lark.reply"] }, NOW)).toBeFalse();
    expect(isActionEligible(act({ kind: "follow_up", source: "gmail" }), cfgOn, NOW)).toBeFalse();
    expect(isActionEligible(act(), { ...cfgOn, kinds: ["github.review"] }, NOW)).toBeFalse();
  });
  test("state 与 stage 状态过滤", () => {
    expect(isActionEligible(act({ state: "snoozed" }), cfgOn, NOW)).toBeTrue();
    for (const state of ["processing", "resolved", "dismissed"] as const) expect(isActionEligible(act({ state }), cfgOn, NOW)).toBeFalse();
    expect(isActionEligible(act({ stage: stage("running") }), cfgOn, NOW)).toBeFalse();
    expect(isActionEligible(act({ stage: stage("ready") }), cfgOn, NOW)).toBeFalse();
    for (const st of ["queued", "stale", "failed"] as const) expect(isActionEligible(act({ stage: stage(st) }), cfgOn, NOW)).toBeTrue();
  });
  test("failed 重试：次数封顶、且要等一个 settle", () => {
    expect(isActionEligible(act({ stage: stage("failed", { attempt: 3 }) }), cfgOn, NOW)).toBeFalse();
    expect(isActionEligible(act({ stage: stage("failed", { updatedAt: minsAgo(1) }) }), cfgOn, NOW)).toBeFalse();
  });
});

describe("checkDailyBudget", () => {
  test("同一天计数、到上限挡住、跨天清零", () => {
    expect(checkDailyBudget({}, "2026-10-15", 2)).toEqual({ allowed: true, count: 0 });
    expect(checkDailyBudget({ staging: { date: "2026-10-15", count: 1 } }, "2026-10-15", 2)).toEqual({ allowed: true, count: 1 });
    expect(checkDailyBudget({ staging: { date: "2026-10-15", count: 2 } }, "2026-10-15", 2)).toEqual({ allowed: false, count: 2 });
    expect(checkDailyBudget({ staging: { date: "2026-10-14", count: 99 } }, "2026-10-15", 2)).toEqual({ allowed: true, count: 0 });
  });
  test("runner：预算用完就停，不调模型；新的一天恢复", async () => {
    const h = harness([act()], { config: { ...cfgOn, dailyBudget: 1 } });
    h.state.staging = { date: "2026-10-15", count: 1 };
    let called = 0; h.deps.llm = async () => { called++; return { body: "x" }; };
    expect((await runStaging(h.deps)).status).toBe("budget_exceeded");
    expect(called).toBe(0);
    expect(h.rows[0].stage).toMatchObject({ status: "queued", error: "budget" });
    h.state.staging = { date: "2026-10-14", count: 1 };
    expect((await runStaging(h.deps)).status).toBe("staged");
    expect(called).toBe(1);
    expect(h.state.staging).toEqual({ date: "2026-10-15", count: 1 });
  });
});

test("computeInputSig：sha256 hex，内容不同签名不同", () => {
  expect(computeInputSig("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(computeInputSig({ a: 1 })).toBe(computeInputSig(JSON.stringify({ a: 1 })));
  expect(computeInputSig({ a: 1 })).not.toBe(computeInputSig({ a: 2 }));
});

test("stagingConfig：缺省与坏值回落默认", () => {
  expect(stagingConfig({})).toEqual(STAGING_DEFAULTS);   // 别传 undefined：会落到本机 cfg.staging
  expect(stagingConfig({ settleMin: "x", dailyBudget: -1, model: "", kinds: "nope" })).toEqual(STAGING_DEFAULTS);
  expect(stagingConfig({ enabled: true, settleMin: 0 })).toMatchObject({ enabled: true, settleMin: 0 });
});

describe("recoverOrphanedRunning", () => {
  test("running 退回 queued，其它不动", () => {
    const rows = [act({ id: "a", stage: stage("running") }), act({ id: "b", stage: stage("ready") }), act({ id: "c" })];
    recoverOrphanedRunning(rows);
    expect(rows.map((a) => a.stage?.status)).toEqual(["queued", "ready", undefined]);
    expect(rows[0].stage!.updatedAt).not.toBe(minsAgo(30));
    expect(rows[1].stage!.updatedAt).toBe(minsAgo(30));
  });
  test("启动恢复会落盘，恢复后的 Action 能再被选中", async () => {
    const h = harness([act({ stage: stage("running", { inputSig: "old" }) })]);
    expect(recoverOrphanedStages(h)).toBe(1);
    expect(h.writes).toHaveLength(1);
    expect(h.rows[0].stage).toMatchObject({ status: "queued", inputSig: "old" });
    expect((await runStaging(h.deps)).status).toBe("staged");
  });
});

describe("runStaging", () => {
  test("成功：存产物、stage 置 ready 带 preview/inputSig、预算 +1", async () => {
    const h = harness([act({ id: "young", createdAt: minsAgo(1) }), act()]);
    const r = await runStaging(h.deps);
    expect(r).toEqual({ status: "staged", stagedId: "lark:oc_1" });
    const st = h.rows[1].stage!;
    expect(st).toMatchObject({ status: "ready", kind: "reply_draft", attempt: 1, preview: "约明天下午" });
    expect(st.inputSig).toMatch(/^[0-9a-f]{64}$/);
    expect(h.writes.map((w) => w.stage.status)).toEqual(["running", "running", "ready"]);
    expect(h.artifacts).toHaveLength(1);
    expect(h.artifacts[0]).toMatchObject({ v: 1, actionId: "lark:oc_1", kind: "reply_draft", inputSig: st.inputSig, model: "sonnet", body: "可以，明天下午三点？", caveats: ["时间待确认"] });
    expect(h.state.staging).toEqual({ date: "2026-10-15", count: 1 });
    expect(h.prompts[0]).toStartWith("PROMPT:stage-reply.md");
    expect(h.prompts[0]).toContain("我: 在吗");
    expect(h.prompts[0]).toContain("张三: 明天能评审吗？");
    expect(h.prompts[0].indexOf("在吗")).toBeLessThan(h.prompts[0].indexOf("明天能评审吗"));   // 时间正序
    expect(h.rows[0].stage).toBeUndefined();
  });

  test("没有候选 / 未开启", async () => {
    expect((await runStaging(harness([act({ createdAt: minsAgo(1) })]).deps)).status).toBe("no_candidates");
    expect(await runStaging(harness([act()], { config: { ...cfgOn, enabled: false } }).deps)).toMatchObject({ status: "skipped", error: "disabled" });
  });

  test("in-flight 守卫：并发 tick 第二个直接跳过", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness([act()], { llm: async () => { await gate; return { body: "ok" }; } });
    const first = runStaging(h.deps);
    expect(await runStaging(h.deps)).toEqual({ status: "skipped", error: "in_flight" });
    release();
    expect((await first).status).toBe("staged");
  });

  describe("CAS：模型跑的期间 Action 变了就作废", () => {
    test("被 resolve", async () => {
      const h = harness([act()]);
      h.deps.llm = async () => { h.rows[0].state = "resolved"; return { body: "x" }; };
      expect(await runStaging(h.deps)).toMatchObject({ status: "skipped", error: "discarded: action closed" });
      expect(h.artifacts).toHaveLength(0);
      expect(h.rows[0].stage!.status).toBe("running");   // 终态不再写；sweep 会连同产物一起清
    });
    test("被 dismiss 后已不在列表", async () => {
      const h = harness([act()]);
      h.deps.llm = async () => { h.rows.splice(0, 1); return { body: "x" }; };
      expect((await runStaging(h.deps)).status).toBe("skipped");
      expect(h.artifacts).toHaveLength(0);
    });
    test("reason 变了：标 stale 以便下一轮重做", async () => {
      const h = harness([act()]);
      h.deps.llm = async () => { h.rows[0].reason = "又来了一条新消息"; return { body: "x" }; };
      expect(await runStaging(h.deps)).toMatchObject({ status: "skipped", error: "discarded: input changed" });
      expect(h.artifacts).toHaveLength(0);
      expect(h.rows[0].stage!.status).toBe("stale");
      expect(isActionEligible(h.rows[0], cfgOn, NOW)).toBeTrue();
    });
    test("别人改写了 inputSig", async () => {
      const h = harness([act()]);
      h.deps.llm = async () => { h.rows[0].stage = { ...h.rows[0].stage!, inputSig: "other" }; return { body: "x" }; };
      expect((await runStaging(h.deps)).status).toBe("skipped");
      expect(h.artifacts).toHaveLength(0);
      expect(h.rows[0].stage!.inputSig).toBe("other");
    });
  });

  describe("StageError 分类", () => {
    test("context_unavailable：缺 chat_id 不调 lark-cli 也不计预算", async () => {
      let ran = 0;
      const h = harness([act({ ref: {} })]);
      h.deps.gather!.runCommand = async () => { ran++; return { code: 0, stdout: larkOk, stderr: "" }; };
      expect(await runStaging(h.deps)).toMatchObject({ status: "failed", error: "context_unavailable" });
      expect(ran).toBe(0);
      expect(h.rows[0].stage).toMatchObject({ status: "failed", error: "context_unavailable", attempt: 1 });
      expect(h.state.staging).toBeUndefined();
    });
    test("context_unavailable：lark-cli 失败 / 坏 JSON / 空会话", async () => {
      for (const res of [{ code: 1, stdout: "", stderr: "auth expired" }, { code: 0, stdout: "{oops", stderr: "" }, { code: 0, stdout: '{"data":{"messages":[]}}', stderr: "" }]) {
        const h = harness([act()]);
        h.deps.gather!.runCommand = async () => res;
        expect((await runStaging(h.deps)).error).toBe("context_unavailable");
      }
    });
    test("llm_unavailable：模型返回 null 或抛错；重试时 attempt 递增", async () => {
      const h = harness([act()], { llm: async () => null });
      expect(await runStaging(h.deps)).toMatchObject({ status: "failed", error: "llm_unavailable" });
      expect(h.rows[0].stage).toMatchObject({ status: "failed", error: "llm_unavailable", attempt: 1 });
      expect(h.state.staging.count).toBe(1);   // 调了就算
      h.rows[0].stage!.updatedAt = minsAgo(30);
      h.deps.llm = async () => { throw new Error("boom"); };
      expect((await runStaging(h.deps)).error).toBe("llm_unavailable");
      expect(h.rows[0].stage!.attempt).toBe(2);
    });
    test("parse：缺 body / 空 body / 非对象", async () => {
      for (const out of [{ preview: "x" }, { body: "   " }, "text"]) {
        const h = harness([act()], { llm: async () => out });
        expect(await runStaging(h.deps)).toMatchObject({ status: "failed", error: "parse" });
        expect(h.artifacts).toHaveLength(0);
      }
    });
  });
});

describe("gatherers", () => {
  const base = { maxInputChars: 24_000, now: NOW };

  test("lark：超长会话从最新往回截，并注明", async () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ create_time: String(NOW.getTime() - (50 - i) * 1000), sender: { id: "ou_a", name: "A" }, content: JSON.stringify({ text: `第${i}条 ` + "x".repeat(80) }) }));
    const ctx = await gatherLarkReply(act(), { ...base, maxInputChars: 1000, runCommand: async () => ({ code: 0, stdout: JSON.stringify({ data: { messages } }), stderr: "" }) });
    expect(ctx.text).toContain("第49条");
    expect(ctx.text).not.toContain("第0条");
    expect(ctx.caveats[0]).toContain("只取了最近");
    expect(ctx.basis[0].label).toContain("条消息，截至");
  });

  test("github：解析 PR 地址、diff 按 maxInputChars 截断", async () => {
    const calls: string[] = [];
    const detail = { repo: "o/r", number: 42, title: "feat", body: "", author: "bob", branch: "f", baseBranch: "main", additions: 1, deletions: 0,
      mergeable: "MERGEABLE", reviewDecision: "", checks: [{ name: "ci", state: "SUCCESS" }], files: [{ path: "a.ts", additions: 1, deletions: 0 }], comments: [], url: "u" };
    const ctx = await gatherGithubReview(act({ kind: "review", source: "github", ref: { url: "https://github.com/o/r/pull/42" } }), {
      ...base, maxInputChars: 100,
      prDetail: async (repo, n) => { calls.push(`detail ${repo}#${n}`); return detail; },
      prDiff: async (repo, n) => { calls.push(`diff ${repo}#${n}`); return "+".repeat(500); },
    });
    expect(calls.sort()).toEqual(["detail o/r#42", "diff o/r#42"]);
    expect(ctx.text).toContain("o/r#42 feat");
    expect(ctx.text).not.toContain("+".repeat(101));
    expect(ctx.caveats).toEqual(["diff 截断到 100 字符，后半部分未看"]);
    expect(ctx.basis[0].label).toBe("PR #42 diff 1 行");
  });

  test("github：拿不到 PR 或 gh 失败都归为 context_unavailable", async () => {
    await expect(gatherGithubReview(act({ kind: "review", source: "github", ref: {} }), base)).rejects.toMatchObject({ code: "context_unavailable" });
    await expect(gatherGithubReview(act({ kind: "review", source: "github", ref: { url: "https://github.com/o/r/pull/1" } }), {
      ...base, prDetail: async () => { throw new Error("gh 403"); }, prDiff: async () => "",
    })).rejects.toMatchObject({ code: "context_unavailable" });
  });

  test("parsePrRef：html / api / repo#n", () => {
    expect(parsePrRef("https://github.com/o/r/pull/42")).toEqual({ repo: "o/r", number: 42 });
    expect(parsePrRef("https://api.github.com/repos/o/r/pulls/7")).toEqual({ repo: "o/r", number: 7 });
    expect(parsePrRef("o/r#3")).toEqual({ repo: "o/r", number: 3 });
    expect(parsePrRef("https://github.com/o/r/issues/3")).toBeNull();
  });

  const mail = (over: any = {}) => ({ from: "张三 <z@x.com>", to: "me@x.com", subject: "季度报价", date: "Thu, 15 Oct 2026 05:00:00 +0000", threadId: "t1", body: "请问报价周五前能给吗？", ...over });
  const gmailAct = (ref: Action["ref"]) => act({ id: "gmail:m1", kind: "reply", source: "gmail", title: "回复 张三", ref });

  test("parseMailRef：mail_id（可带账号前缀）> Gmail 链接 > note", () => {
    expect(parseMailRef({ mail_id: "18a2b3c4d5e6f7a8" })).toEqual({ id: "18a2b3c4d5e6f7a8" });
    expect(parseMailRef({ mail_id: "me@x.com:18a2b3c4d5e6f7a8" })).toEqual({ id: "18a2b3c4d5e6f7a8", account: "me@x.com" });
    expect(parseMailRef({ url: "https://mail.google.com/mail/u/0/#inbox/18a2b3c4d5e6f7a8" })).toEqual({ id: "18a2b3c4d5e6f7a8" });
    expect(parseMailRef({ note: "gmail:18a2b3c4d5e6f7a8" })).toEqual({ id: "18a2b3c4d5e6f7a8" });
    expect(parseMailRef({ note: "work/inbox/2026-10-15.md" })).toBeNull();
    expect(parseMailRef({})).toBeNull();
  });

  test("gmail：格式化主题/发件人/正文，按账号取信，超长正文截断", async () => {
    const calls: any[] = [];
    const ctx = await gatherGmailReply(gmailAct({ mail_id: "me@x.com:m1" }), {
      ...base, maxInputChars: 10, gmailMessage: async (id, account) => { calls.push([id, account]); return mail({ body: "x".repeat(50) }); },
    });
    expect(calls).toEqual([["m1", "me@x.com"]]);
    expect(ctx.text).toContain("主题：季度报价");
    expect(ctx.text).toContain("发件人：张三 <z@x.com>");
    expect(ctx.text).not.toContain("x".repeat(11));
    expect(ctx.caveats).toEqual(["邮件正文截断到 10 字符"]);
    expect(ctx.basis[0]).toEqual({ label: "邮件「季度报价」", at: "2026-10-15T05:00:00.000Z" });
  });

  test("gmail：缺 id / 拉取失败 / 内容为空都归为 context_unavailable", async () => {
    let called = 0;
    await expect(gatherGmailReply(gmailAct({}), { ...base, gmailMessage: async () => { called++; return mail(); } })).rejects.toMatchObject({ code: "context_unavailable" });
    expect(called).toBe(0);
    await expect(gatherGmailReply(gmailAct({ mail_id: "m1" }), { ...base, gmailMessage: async () => { throw new Error("401"); } })).rejects.toMatchObject({ code: "context_unavailable" });
    await expect(gatherGmailReply(gmailAct({ mail_id: "m1" }), { ...base, gmailMessage: async () => mail({ subject: "", body: "  " }) })).rejects.toMatchObject({ code: "context_unavailable" });
  });

  test("runner 走 gmail 分支用邮件 prompt 与 reply_draft", async () => {
    const h = harness([gmailAct({ mail_id: "m1" })]);
    h.deps.gather!.gmailMessage = async () => mail();
    expect((await runStaging(h.deps)).status).toBe("staged");
    expect(h.prompts[0]).toStartWith("PROMPT:stage-mail-reply.md");
    expect(h.prompts[0]).toContain("请问报价周五前能给吗？");
    expect(h.artifacts[0].kind).toBe("reply_draft");
  });

  test("runner 走 github 分支用 review prompt 与 review_brief", async () => {
    const h = harness([act({ id: "gh:1", kind: "review", source: "github", ref: { url: "https://github.com/o/r/pull/42" } })]);
    h.deps.gather!.prDetail = async () => ({ repo: "o/r", number: 42, title: "t", body: "", author: "", branch: "", baseBranch: "", additions: 0, deletions: 0, mergeable: "", reviewDecision: "", checks: [], files: [], comments: [], url: "" });
    h.deps.gather!.prDiff = async () => "diff";
    expect((await runStaging(h.deps)).status).toBe("staged");
    expect(h.prompts[0]).toStartWith("PROMPT:stage-review.md");
    expect(h.artifacts[0].kind).toBe("review_brief");
  });
});
