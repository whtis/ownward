// 晨会/周会文档取材：按周切、按人抽、格子 HTML 变人话。
// 背景：月度复盘要覆盖同项目同事的工作，本人 vault 里没有他们的日志，只能从会议文档的表格里抽。
import { describe, expect, test } from "bun:test";
import { cellToText, extractMeetingRows, parseWeekRange, renderMeetingRows } from "./meeting-notes.ts";

const user = (name: string) => `<cite type="user" user-id="ou_x" user-name="${name}"></cite>`;
const row = (name: string, ...cells: string[]) => `<tr><td>${user(name)}</td>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
const standupTable = (rows: string) =>
  `<table><colgroup></colgroup><thead><tr><th>人员</th><th>本周目标/要事</th><th>周一</th><th>周二</th></tr></thead><tbody>${rows}</tbody></table>`;

const doc = [
  "<title>2026产研晨会</title>",
  "",
  "# 08.31-09.04",
  "",
  standupTable(
    row("Alex 张三", "<ol><li seq=\"1\">指标纳入报表</li></ol>", "计划：<ol><li>看板</li></ol><hr/><br/>结果：<ol><li>看板上线</li></ol>", "计划：<hr/><br/>结果：")
    + row("Blair 李四", "", "计划：<hr/><br/>结果：<ul><li>妙记接入<ul><li>逐字稿链路跑通</li></ul></li></ul>", "计划：<hr/><br/>结果：")
    + row("Chris 王五", "<ol><li>季度复盘</li></ol>", "计划：<hr/><br/>结果：<ol><li>初稿</li></ol>", ""),
  ),
  "",
  "# 07.27-07.31",
  "",
  standupTable(row("Alex 张三", "", "计划：<hr/><br/>结果：<ol><li>七月末的事</li></ol>", "")),
  "",
  "# 模板",
  "",
  standupTable(row("Alex 张三", "", "计划：<hr/><br/>结果：<ol><li>模板里的假内容</li></ol>", "")),
].join("\n");

const augustDays = Array.from({ length: 31 }, (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`);

describe("parseWeekRange", () => {
  test("兼容点分、纯数字、带空格三种周标题", () => {
    expect(parseWeekRange("# 08.31-09.04", 2026)[0]).toEqual({ start: "2026-08-31", end: "2026-09-04" });
    expect(parseWeekRange("# 0831-0904", 2026)[0]).toEqual({ start: "2026-08-31", end: "2026-09-04" });
    expect(parseWeekRange("# 0511 - 0515", 2026)[0]).toEqual({ start: "2026-05-11", end: "2026-05-15" });
  });
  test("跨年的周结束日进下一年；非日期标题不算周", () => {
    expect(parseWeekRange("# 12.29-01.02", 2026)[0]).toEqual({ start: "2026-12-29", end: "2027-01-02" });
    expect(parseWeekRange("# 模板", 2026)).toEqual([]);
    expect(parseWeekRange("## 研发复盘", 2026)).toEqual([]);
  });
});

describe("cellToText", () => {
  test("列表变缩进短横，分隔线变换行，实体反转义", () => {
    const t = cellToText("计划：<ol><li seq=\"1\">A &amp; B</li></ol><hr/><br/>结果：<ul><li>外<ul><li>内</li></ul></li></ul>");
    expect(t).toBe("计划：\n- A & B\n\n结果：\n- 外\n  - 内");
  });
  test("文档引用留标题，人员引用留姓名", () => {
    expect(cellToText(`看 <cite doc-id="x" file-type="docx" title="8月复盘&amp;9月目标" type="doc"></cite> 和 ${user("Blair 李四")}`))
      .toBe("看 「文档：8月复盘&9月目标」 和 Blair 李四");
  });
});

describe("extractMeetingRows", () => {
  test("只取窗口内的周、只取点名的人、空骨架格子不算内容", () => {
    const rows = extractMeetingRows(doc, augustDays, ["张三", "李四"]);
    // 7.27-7.31 那周整周在 8 月之前，不相交，不取；王五没点名，不取
    expect(rows.map((r) => `${r.week}|${r.person}`)).toEqual([
      "08.31-09.04|Alex 张三",
      "08.31-09.04|Blair 李四",
    ]);
    const tis = rows[0];
    expect(tis.cells.map((c) => c.col)).toEqual(["本周目标/要事", "周一"]);   // 周二是空骨架，被丢掉
    expect(tis.cells[1].text).toContain("看板上线");
    const ivy = rows[1];
    expect(ivy.cells).toHaveLength(1);
    expect(ivy.cells[0].text).toContain("  - 逐字稿链路跑通");
  });
  test("跨月的周按相交取：7.27-7.31 那周对 8 月窗口不相交，对 7 月窗口相交；模板节永远不取", () => {
    const julyDays = ["2026-07-01", "2026-07-31"];
    const rows = extractMeetingRows(doc, julyDays, ["张三"]);
    expect(rows.map((r) => r.week)).toEqual(["07.27-07.31"]);
    expect(JSON.stringify(rows)).not.toContain("模板里的假内容");
  });
  test("标签带属性（<table border> <th style> <tr class> <td style>）照样解析，不会整张表静默丢掉", () => {
    const styled = "# 0803-0807\n\n<table border=\"1\"><thead><tr class=\"h\"><th style=\"width:80px\">人员</th><th>周一</th></tr></thead><tbody>"
      + `<tr class="d"><td style="color:red">${user("Blair 李四")}</td><td align="left">计划：<hr/>结果：<ol><li>带属性也行</li></ol></td></tr></tbody></table>`;
    const rows = extractMeetingRows(styled, augustDays, ["李四"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].cells).toEqual([{ col: "周一", text: "计划：\n结果：\n- 带属性也行" }]);
  });
  test("没有人员表头的表格（周会里的质量复盘等）跳过", () => {
    const other = "# 0803-0807\n\n## 质量复盘\n\n<table><thead><tr><th>问题</th><th>处理</th></tr></thead><tbody><tr><td>张三</td><td>x</td></tr></tbody></table>";
    expect(extractMeetingRows(other, augustDays, ["张三"])).toEqual([]);
  });
  test("周会文档：表格归属最近的二级标题", () => {
    const weekly = "# 0831-0904\n\n## 研发复盘\n\n<table><thead><tr><th>人员</th><th>本周目标</th><th>达成情况</th><th>下周计划</th></tr></thead><tbody>"
      + row("Blair 李四", "<ul><li>妙记对接</li></ul>", "<ol><li>接入卡片</li></ol>", "<ol><li>迁 Temporal</li></ol>") + "</tbody></table>";
    const rows = extractMeetingRows(weekly, augustDays, ["李四"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].section).toBe("研发复盘");
    expect(rows[0].cells.map((c) => c.col)).toEqual(["本周目标", "达成情况", "下周计划"]);
    const text = renderMeetingRows("周会", rows);
    expect(text).toContain("----- 周会 · 0831-0904 · 研发复盘 · Blair 李四 -----");
    expect(text).toContain("[达成情况]\n- 接入卡片");
  });
});
