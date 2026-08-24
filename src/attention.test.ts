// 注意力收件箱判定的纯逻辑单测：给定会话/任务快照，验证两类分类（卡住/待收尾）及其优先级、
// 阈值边界正确。审批已归 Action 队列，不再在注意力里判定。另测取样口径：活会话不被 MAX_TASKS 裁掉。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { classify, DONE_RECENT_MS, MAX_TASKS, pickTasks, STUCK_MS, type SessionSnapshot } from "./attention.ts";

test("collector reduces Run journal once and crops before Session state", () => {
  const source = readFileSync(import.meta.filename.replace(/\.test\.ts$/, ".ts"), "utf8");
  expect(source.match(/reduceRuns\(/g)).toHaveLength(1);
  expect(source.indexOf("const picked = pickTasks")).toBeLessThan(source.indexOf("service.states(ids)"));
  expect(source).not.toMatch(/readRunJournalStrict\(DATA\)[^\n]*catch/);
  expect(source).toContain("createSessionService(taskId, cfg.architecture?.allowedRoots ?? [], DATA)");
  expect(source).not.toContain("sessionRunnerTaskIds");
});

const NOW = 1_800_000_000_000;

// 默认快照：一个正常运行、无需关注的活会话
function snap(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    taskId: "t1", project: "ownward", backend: "claude",
    live: true, turn: "running", alive: true,
    lastActivityAt: NOW - 1_000,
    status: "running", harvested: false,
    titleText: "实现注意力收件箱", now: NOW,
    ...over,
  };
}

describe("classify 审批不再进注意力（归 Action 队列）", () => {
  test("活会话即便很久没活动，也只按卡住判定，不产生 approve", () => {
    const item = classify(snap({ lastActivityAt: NOW - STUCK_MS - 60_000 }));
    expect(item?.kind).toBe("stuck");
    expect((item?.kind as string)).not.toBe("approve");
  });
});

describe("classify 卡住 stuck（用 lastActivityAt）", () => {
  test("running 且最后活动超过阈值 → stuck", () => {
    const last = NOW - STUCK_MS - 60_000;
    const item = classify(snap({ lastActivityAt: last }));
    expect(item?.kind).toBe("stuck");
    expect(item?.detail).toContain("分钟");
    expect(item?.since).toBe(last);
  });

  test("刚好在阈值内 → 不算卡住", () => {
    const item = classify(snap({ lastActivityAt: NOW - STUCK_MS + 5_000 }));
    expect(item).toBeNull();
  });

  test("持续活动（新鲜 lastActivityAt）即便无展示消息也不误判卡住", () => {
    // 关键回归：持续 partial 流 / 长命令 / 成功工具执行会 touch lastActivityAt，
    // 不再靠「最后一条展示消息时间」，因此不会误报。
    const item = classify(snap({ lastActivityAt: NOW - 3_000 }));
    expect(item).toBeNull();
  });

  test("进程已死但 turn 仍 running → stuck（异常）", () => {
    const item = classify(snap({ alive: false, lastActivityAt: NOW - 1_000 }));
    expect(item?.kind).toBe("stuck");
    expect(item?.detail).toContain("进程已退出");
  });

  test("无任何活动（lastActivityAt=0）的运行中会话不误判卡住", () => {
    const item = classify(snap({ lastActivityAt: 0 }));
    expect(item).toBeNull();
  });
});

describe("classify 待收尾 done", () => {
  test("最近结束、未收割 → done", () => {
    const ended = NOW - 60_000;
    const item = classify(snap({ live: false, turn: "idle", alive: false, status: "exited", endedAt: ended, harvested: false }));
    expect(item?.kind).toBe("done");
    expect(item?.since).toBe(ended);
  });

  test("已收割 → 不提示", () => {
    const item = classify(snap({ live: false, turn: "idle", status: "exited", endedAt: NOW - 60_000, harvested: true }));
    expect(item).toBeNull();
  });

  test("结束太久（超过 DONE_RECENT_MS）→ 不提示", () => {
    const item = classify(snap({ live: false, turn: "idle", status: "exited", endedAt: NOW - DONE_RECENT_MS - 60_000, harvested: false }));
    expect(item).toBeNull();
  });

  test("routine 任务自完成 → 不提示收尾", () => {
    const item = classify(snap({ live: false, turn: "idle", status: "done", endedAt: NOW - 60_000, harvested: false, kind: "routine" }));
    expect(item).toBeNull();
  });

  test("演进任务验证通过待上线 → done，文案指向 apply", () => {
    const item = classify(snap({ live: false, turn: "idle", status: "exited", endedAt: NOW - 60_000, harvested: false, kind: "evolve", verify: "pass", applied: false }));
    expect(item?.kind).toBe("done");
    expect(item?.detail).toContain("apply");
  });
});

describe("classify 正常态不产生条目", () => {
  test("运行中且活动新鲜 → null", () => {
    expect(classify(snap({ lastActivityAt: NOW - 1_000 }))).toBeNull();
  });
  test("空闲活会话、无产出待收（已收割）→ null", () => {
    expect(classify(snap({ turn: "idle", status: "running", harvested: true }))).toBeNull();
  });
});

describe("pickTasks 取样口径：活会话不被 MAX_TASKS 裁掉", () => {
  // 构造 MAX_TASKS + 5 个任务（已按 startedAt 倒序），最老的一个仍是活会话
  const dev = Array.from({ length: MAX_TASKS + 5 }, (_, i) => ({ id: `t${i}` }));
  const oldestLiveId = dev[dev.length - 1].id; // 排在 MAX_TASKS 窗口之外

  test("排在窗口外的活会话仍被纳入", () => {
    const picked = pickTasks(dev, (id) => id === oldestLiveId);
    expect(picked.some((t) => t.id === oldestLiveId)).toBe(true);
  });

  test("排在窗口外的非活任务被裁掉", () => {
    const picked = pickTasks(dev, () => false);
    expect(picked.some((t) => t.id === oldestLiveId)).toBe(false);
    expect(picked.length).toBe(MAX_TASKS);
  });

  test("去重：既是活会话又在最近窗口内，只出现一次", () => {
    const picked = pickTasks(dev, (id) => id === dev[0].id);
    expect(picked.filter((t) => t.id === dev[0].id).length).toBe(1);
  });
});
