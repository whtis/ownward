import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { formatGoalsForPrompt, getActiveGoals, parseGoals, toggleGoal, useGoalsFileForTest } from "./goals.ts";
import { fmt } from "./util.ts";

const SAMPLE = [
  "---", "type: weekly_goals", "week: 2026-W42", "updated_at: 2026-10-12", "---", "",
  "# 本周目标（2026-W42）", "",
  "> 新的一周：确认/改写下面的目标（周会定了就同步过来），删掉这行即完成。", "",
  "- [ ] [ownward] 上线长效目标卡片",
  "- [x] 写完周报",
  "* [X] [ops ] 迁移监控",
  "- 普通条目不算目标",
  "", "```", "- [ ] 代码块里的不算", "```", "",
  "## 历史", "",
  "### 2026-W41", "- [ ] 上周没做完的", "",
].join("\n");

let dir = "", file = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ownward-goals-"));
  file = join(dir, "goals.md");
  useGoalsFileForTest(file);
});
afterEach(() => {
  useGoalsFileForTest(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("parseGoals", () => {
  test("frontmatter + 当前周的待办；跳过普通条目、代码块与历史段", () => {
    const s = parseGoals(SAMPLE);
    expect(s.week).toBe("2026-W42");
    expect(s.updatedAt).toBe("2026-10-12");
    expect(s.goals.map((g) => [g.text, g.done, g.project])).toEqual([
      ["上线长效目标卡片", false, "ownward"],
      ["写完周报", true, undefined],
      ["迁移监控", true, "ops"],
    ]);
    expect(s.goals[1]).not.toHaveProperty("project");
    for (const g of s.goals) expect(g.id).toMatch(/^g-[0-9a-f]{8}$/);
  });
  test("id 只跟文本走：位置挪了 id 不变；同句重复各自一个 id", () => {
    const a = parseGoals("- [ ] 甲\n- [ ] 乙\n").goals;
    const b = parseGoals("- [ ] 乙\n- [x] 甲\n").goals;
    expect(b.find((g) => g.text === "甲")!.id).toBe(a.find((g) => g.text === "甲")!.id);
    const dup = parseGoals("- [ ] 同\n- [ ] 同\n").goals;
    expect(dup[1].id).toBe(`${dup[0].id}-2`);
  });
  test("没有 frontmatter 也能解析，week 为空串", () => {
    const s = parseGoals("- [ ] 只有一条\n");
    expect(s.week).toBe("");
    expect(s.updatedAt).toBeUndefined();
    expect(s.goals).toHaveLength(1);
  });
});

describe("getActiveGoals", () => {
  test("文件不存在 / 空文件 → null", () => {
    expect(getActiveGoals()).toBeNull();
    writeFileSync(file, "  \n");
    expect(getActiveGoals()).toBeNull();
  });
  test("读出当前文件", () => {
    writeFileSync(file, SAMPLE);
    expect(getActiveGoals()?.goals).toHaveLength(3);
  });
});

describe("toggleGoal", () => {
  test("翻勾选、刷新 updated_at，其余内容原样保留，不留临时文件", () => {
    writeFileSync(file, SAMPLE);
    const id = getActiveGoals()!.goals[0].id;
    expect(toggleGoal(id, true)).toBeTrue();
    const after = readFileSync(file, "utf8");
    expect(after).toContain("- [x] [ownward] 上线长效目标卡片");
    expect(after).toContain(`updated_at: ${fmt(new Date(), "date")}`);
    expect(after.replace(/updated_at: .*/, "").replace("- [x] [ownward]", "- [ ] [ownward]"))
      .toBe(SAMPLE.replace(/updated_at: .*/, ""));
    expect(getActiveGoals()!.goals[0]).toMatchObject({ id, done: true });
    expect(readdirSync(dir)).toEqual(["goals.md"]);

    expect(toggleGoal(id, false)).toBeTrue();
    expect(readFileSync(file, "utf8")).toContain("- [ ] [ownward] 上线长效目标卡片");
  });
  test("大写 X 也能取消；历史段那条不受影响", () => {
    writeFileSync(file, SAMPLE);
    const g = getActiveGoals()!.goals.find((x) => x.text === "迁移监控")!;
    expect(toggleGoal(g.id, false)).toBeTrue();
    const after = readFileSync(file, "utf8");
    expect(after).toContain("* [ ] [ops ] 迁移监控");
    expect(after).toContain("- [ ] 上周没做完的");
  });
  test("已是目标状态：返回 true 且不写盘", () => {
    writeFileSync(file, SAMPLE);
    const id = getActiveGoals()!.goals[1].id;
    expect(toggleGoal(id, true)).toBeTrue();
    expect(readFileSync(file, "utf8")).toBe(SAMPLE);
  });
  test("找不到的 id / 文件缺失 → false", () => {
    expect(toggleGoal("g-00000000", true)).toBeFalse();
    writeFileSync(file, SAMPLE);
    expect(toggleGoal("g-00000000", true)).toBeFalse();
    expect(readFileSync(file, "utf8")).toBe(SAMPLE);
  });
  test("frontmatter 没有 updated_at 时补上", () => {
    writeFileSync(file, "---\nweek: 2026-W42\n---\n- [ ] 甲\n");
    expect(toggleGoal(getActiveGoals()!.goals[0].id, true)).toBeTrue();
    expect(readFileSync(file, "utf8")).toBe(`---\nweek: 2026-W42\nupdated_at: ${fmt(new Date(), "date")}\n---\n- [x] 甲\n`);
  });
});

describe("formatGoalsForPrompt", () => {
  test("精简清单：周 + 完成数 + 每条带项目标签", () => {
    writeFileSync(file, SAMPLE);
    expect(formatGoalsForPrompt()).toBe([
      "本周目标（2026-W42）：已完成 2/3",
      "- [ ] [ownward] 上线长效目标卡片",
      "- [x] 写完周报",
      "- [x] [ops] 迁移监控",
    ].join("\n"));
  });
  test("没有目标 → 空串（调用方据此整段不注入）", () => {
    expect(formatGoalsForPrompt()).toBe("");
    writeFileSync(file, "---\nweek: 2026-W42\n---\n- 只有普通条目\n");
    expect(formatGoalsForPrompt()).toBe("");
  });
});
