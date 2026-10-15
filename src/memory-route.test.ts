// 日报提取的候选记忆按项目分流：决策属于某个有负责角色的项目，就进那个项目的候选（角色页审）。
// 修的问题：memory/_candidates 积了 33 天 73 条没人合（2026-10 生产数据），其中 49 条决策大多写明了
// 该进哪个项目——混在一个大堆里审不动，分到各自角色名下才有上下文。
import { describe, expect, test } from "bun:test";
import { routeCandidates } from "./memory.ts";

describe("routeCandidates", () => {
  test("只有「决策 + 有负责角色的项目」才分出去；人物/承诺/目标、没归属或项目没角色的留在当日这份", () => {
    const owned = new Set(["acme-app", "biz-ops"]);
    const cands = [
      { type: "decision", text: "白名单开关存 DB", project: "ACME-App" },
      { type: "decision", text: "跨项目的约定", project: "" },
      { type: "decision", text: "没有角色的项目", project: "ghost" },
      { type: "commitment", text: "周五前给评审意见", project: "acme-app" },
      { type: "person", text: "新认识的对接人" },
      { type: "decision", text: "周报模板唯一化", project: "biz-ops" },
      null,
    ];
    const { toProject, rest } = routeCandidates(cands, owned);
    expect(toProject.map((x) => [x.slug, x.c.text])).toEqual([["acme-app", "白名单开关存 DB"], ["biz-ops", "周报模板唯一化"]]);
    expect(rest.map((c) => c?.text ?? null)).toEqual(["跨项目的约定", "没有角色的项目", "周五前给评审意见", "新认识的对接人", null]);
  });
});
