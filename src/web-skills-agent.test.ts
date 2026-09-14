// 「设置 → Skills → Agent 建议」页的三条交互契约。回归背景（2026-09-01 实测）：
// 14 条建议时主按钮落在 y=1248（视口 900）、还左对齐，得滚到底才点得到；
// 顶部写着「确定性降级建议」这种实现术语；点开的审批对话框贴死在视口左上角。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const settings = readFileSync(join(import.meta.dir, "..", "web", "settings.js"), "utf8");
const css = readFileSync(join(import.meta.dir, "..", "web", "style.css"), "utf8");

describe("建议页的主操作够得着", () => {
  test("操作条在列表之前，主按钮只有一个且在操作条里", () => {
    const bar = settings.indexOf('class="proposal-bar"'), list = settings.indexOf('class="proposal-list"'), button = settings.indexOf('id="skills-build-plan"');
    expect(bar).toBeGreaterThan(-1);
    expect(bar).toBeLessThan(list);                                  // 操作条在列表上方
    expect(button).toBeGreaterThan(bar);
    expect(button).toBeLessThan(list);                               // 按钮在操作条里，不是吊在列表底下
    expect(settings.split('id="skills-build-plan"').length - 1).toBe(1);   // 只有一个主按钮，不上下各来一个
  });

  test("操作条是 sticky 且背景不透明（滚动内容不许透上来）", () => {
    const rule = css.slice(css.indexOf(".proposal-bar {"), css.indexOf(".proposal-bar .count"));
    expect(rule).toContain("position:sticky");
    expect(rule).toContain("top:0");
    expect(rule).toContain("background:var(--surface-popover)");
  });

  test("有全选/清空和已选计数", () => {
    for (const id of ["skills-select-all", "skills-select-none"]) {
      expect(settings).toContain(`id="${id}"`);
      expect(settings).toContain(`$("#${id}",content)`);            // 渲染了就得绑上
    }
    expect(settings).toContain("已选 ");
  });
});

describe("规则兜底的建议要说人话", () => {
  test("不再出现实现术语「确定性降级」", () => {
    expect(settings).not.toContain("确定性降级");
  });
  // 2026-09-03 起规则不再是「兜底」而是默认路径，文案随之改：说清规则怎么判，Agent 是可选入口。
  test("讲清楚是规则生成的、怎么判的，并给真的能用 Agent 的可选入口", () => {
    expect(settings).toContain("规则生成的建议");
    expect(settings).toContain("按名称与内容指纹确定性生成");
    expect(settings).toContain("用 Agent 分析（可选）");
    const at = settings.indexOf("用 Agent 分析（可选）", settings.indexOf("const analyzeBlocked")), fallback = settings.slice(at - 400, at);
    expect(fallback).toContain('id="skills-analyze"');               // 复用既有行为，不是个假按钮
    expect(fallback).toContain("analyzeBlocked");                    // 扫描不全 / 控制面冻结时同样禁用
  });
});

describe("建议正文不再是裸 JSON", () => {
  const block = settings.slice(settings.indexOf("function proposalObs("), settings.indexOf("function skillAgentHtml()"));
  const view = (skills: unknown, registry: unknown) =>
    Function("Settings", `${block}; return { proposalView, proposalObsLabel };`)({ skills, registry });

  test("四种动作都渲染成「动作 + Skill + 位置」", () => {
    const api = view({ observations: [{ id: "o1", name: "secondary-project", engine: "claude", scope: "user", displayPath: "~/.claude/skills/secondary-project" }] }, { skills: [{ id: "sk1", name: "secondary-project" }] });
    expect(api.proposalView({ kind: "delete", observationId: "o1" })).toMatchObject({ title: "删除部署" });
    expect(api.proposalView({ kind: "delete", observationId: "o1" }).detail).toContain("~/.claude/skills/secondary-project");
    expect(api.proposalView({ kind: "adopt", observationIds: ["o1"] }).title).toBe("纳管 secondary-project");
    expect(api.proposalView({ kind: "migrate", skillId: "sk1", engine: "codex", removeSource: true }).title).toBe("迁移到 codex（并移除原部署）");
    expect(api.proposalView({ kind: "repair", skillId: "sk1", engine: "claude" }).title).toBe("重建 claude 受管链接");
  });

  test("解析不出来就退回原始 ID，不猜路径", () => {
    const api = view({ observations: [] }, { skills: [] });
    expect(api.proposalObsLabel("o-missing")).toBe("o-missing");
    expect(api.proposalView({ kind: "delete", observationId: "o-missing" }).detail).toBe("o-missing");
    expect(api.proposalView({ kind: "future-kind" }).title).toBe("future-kind");   // 新动作类型不许渲染成空白
  });

  test("原始 JSON 收进 details 备排障，仍然走 esc", () => {
    const start = settings.indexOf("data-proposal-index="), row = settings.slice(start, settings.indexOf("</label>", start));
    expect(row).toContain("<details><summary>原始动作</summary>");
    expect(row).toContain("esc(JSON.stringify(action))");
    expect(row).toContain("esc(view.title)");
  });
});

describe("模态对话框居中", () => {
  test("基础规则给 margin:auto —— 通用重置 * { margin:0 } 抹掉了 UA 的居中", () => {
    const base = css.slice(css.indexOf(".control-dialog {"), css.indexOf(".control-dialog::backdrop"));
    expect(base).toContain("margin:auto");
  });
  test("写在类上而不是 dialog:modal 上：移动端全屏那条覆盖必须还赢", () => {
    expect(css).not.toContain("dialog:modal");
    const mobile = css.slice(css.indexOf("@media (max-width:700px)"));
    expect(mobile.indexOf(".control-dialog { width:100vw")).toBeGreaterThan(-1);
    expect(mobile.slice(mobile.indexOf(".control-dialog { width:100vw"), mobile.indexOf(".control-dialog { width:100vw") + 200)).toContain("margin:0");
  });
});

describe("0 条建议要解释为什么", () => {
  const block = settings.slice(settings.indexOf("function proposalEmptyText()"), settings.indexOf("function skillAgentHtml()"));
  const text = (summary: unknown) => Function("Settings", `${block}; return proposalEmptyText();`)({ skills: { summary } });
  // 2026-09-04 起冲突在本页就地处理，不再支去目录
  test("重复已全纳管、剩冲突：说明可以就地选一版为准", () => {
    expect(text({ duplicates: 0, conflicts: 15 })).toContain("15 个冲突");
    expect(text({ duplicates: 0, conflicts: 15 })).toContain("查看两侧差异");
    expect(text({ duplicates: 0, conflicts: 15 })).not.toContain("去「目录」");
  });
  test("什么都不剩：直说没有需要整理的", () => { expect(text({ duplicates: 0, conflicts: 0 })).toContain("没有需要整理"); });
  test("还有重复但规则没出建议：引导改用 Agent", () => { expect(text({ duplicates: 3, conflicts: 0 })).toContain("改用 Agent"); });
});

// 事务 committed 之后「Agent 建议」页仍显示操作前的快照：8 条建议全勾着、指着刚被删掉的
// observation（2026-09-02 实测）。loadSkills() 只刷新 skills/transactions/registry，
// 从来没碰过 Settings.analysis，那份建议就这么活过了 apply。
describe("Skill 建议在事务提交后必须作废", () => {
  test("apply 成功后清掉建议、选中态和 plan，且排在 loadSkills 之后", () => {
    const apply = settings.slice(settings.indexOf("async function applySkillPlan"));
    const body = apply.slice(0, apply.indexOf("}catch"));
    for (const cleared of ["Settings.analysis=null", "Settings.selectedActions.clear()", "Settings.plan=null"])
      expect(body).toContain(cleared);
    // catch 分支要读 Settings.plan.effects 还原按钮文案，清理必须在 loadSkills 之后
    expect(body.indexOf("loadSkills(true)")).toBeLessThan(body.indexOf("Settings.plan=null"));
  });

  test("目录变了就把建议标成过期，且用 mutableRevision 判定", () => {
    expect(settings).toContain("function analysisStale()");
    const fn = settings.slice(settings.indexOf("function analysisStale()"), settings.indexOf("function skillAgentHtml()"));
    // 必须比 mutableRevision：codex 每次运行都重写只读根，拿 revision 判会让建议秒秒钟"过期"
    expect(fn).toContain("mutableRevision");
    expect(fn).not.toContain("Settings.skills?.revision");
    const render = settings.slice(settings.indexOf("function skillAgentHtml()"));
    expect(render.slice(0, render.indexOf("if(!Settings.analysis)"))).toContain("建议已过期");
  });
});

// 「N 个相同版本位置」以前是写死的断言，并没有真比对内容：截图里 6 个不同名的 xhs-* 也这么标，
// 用户点下去才拿到一句没有出路的 SKILL_ADOPT_CONFLICT。点之前就该把话说准。
test("采纳建议的位置说明要真比指纹，不一致就直说无法一起采纳", () => {
  const view = settings.slice(settings.indexOf("function proposalView"), settings.indexOf("function proposalEmptyText"));
  expect(view).toContain("targetTreeDigest");                 // 真的取指纹来比
  expect(view).toContain("内容并不相同");                      // 不一致时明说
  expect(view).toMatch(/逐个采纳|只勾一个/);                    // 并给出路
});

// 恢复流程必须和服务端一个口径：发 mutableRevision。发 revision 的话，只读根一被 codex 重写
// 就永远对不上——用户点了恢复、弹窗也过了，审批却永远消费不掉（2026-09-03 实测）。
// 六个调用点（冲突预览 / Agent 整理 / 建计划 / 执行 / 恢复×2）必须一律发 mutableRevision，
// 和服务端的门同口径。漏一个，那条路就会在只读根被 codex 重刷后无谓地判「已变化」。
test("所有 inventory 门的调用点都发 mutableRevision", () => {
  expect(settings).not.toContain("expectedRevision:Settings.skills.revision");
  expect(settings).not.toMatch(/expectedRevision:[a-zA-Z.]*\.revision\b/);
  // 五条走页面缓存的（冲突预览 / 整理 / 建计划 / 执行 / 冲突差异）+ 恢复流程两处走现取清单的
  expect((settings.match(/expectedRevision:Settings\.skills\.mutableRevision/g) || []).length).toBe(5);
  expect((settings.match(/expectedRevision:inventory\.mutableRevision/g) || []).length).toBe(2);
});

test("恢复流程发的是 mutableRevision，不是 revision", () => {
  const fn = settings.slice(settings.indexOf("async function reviewRollback"));
  const body = fn.slice(0, fn.indexOf("renderSettings()})}catch"));
  expect(body).toContain("/rollback/approval");
  expect(body).not.toContain("expectedRevision:Settings.skills.revision");
  // daemon 重启后页面的 Settings.skills 是 null（GET /api/skills 404），恢复前必须现取清单，
  // 两处都用现取的 inventory.mutableRevision（2026-09-03：Cannot read properties of null）
  expect(body).not.toContain("Settings.skills.mutableRevision");
  expect(body.indexOf("await currentInventory()")).toBeLessThan(body.indexOf("/rollback/approval"));
  expect((body.match(/expectedRevision:inventory\.mutableRevision/g) || []).length).toBe(2);
  const helper = settings.slice(settings.indexOf("async function currentInventory"), settings.indexOf("async function reviewRollback"));
  expect(helper).toContain("SKILL_SCAN_REQUIRED");                 // 404 时补扫一次，而不是空指针
});

// 2026-09-03：部署期间 daemon 重启，页面扫描失败 → 操作记录整块消失，用户以为记录丢了。
// 事务列表和恢复入口是在扫描之后才取的，扫描一挂就不执行；而错误提示又要求「有旧数据」才显示，
// 于是页面一片空白还不解释。扫描失败恰恰是最需要回滚的时候，恢复入口不能跟着一起消失。
describe("扫描失败不能连带藏掉恢复入口", () => {
  const load = settings.slice(settings.indexOf("async function loadSkills"), settings.indexOf("function renderSkills"));
  test("事务与注册表独立于扫描获取", () => {
    // 两个请求必须在 try 之前就发出，且不被扫描的成败左右
    expect(load.indexOf("/api/skills/transactions")).toBeLessThan(load.indexOf("try{Settings.skills"));
    expect(load).toContain('requestJSON("/api/skills/transactions").catch');
    expect(load.indexOf("Settings.transactions=")).toBeGreaterThan(load.indexOf("catch(error){Settings.skillsError"));
  });
  test("有错就显示，不再要求同时有旧数据", () => {
    expect(settings).not.toContain("Settings.skillsError&&Settings.skills?stateBox");
    expect(settings).toContain('${Settings.skillsError?stateBox(Settings.skillsError,"error"):""}');
  });
});

// 2026-09-03 做减法：规则成为默认，Agent 退为可选；纳管可一步部署到别的引擎；冲突可看差异、选一版为准。
describe("规则优先的整理页", () => {
  test("标签叫整理建议，空态主按钮是规则、Agent 是可选", () => {
    expect(settings).toContain('data-skill-mode="agent" data-on="${Settings.skillMode==="agent"}">整理建议</button>');
    expect(settings).toContain('id="skills-analyze-rules"');
    expect(settings).toContain('runSkillAnalysis([],undefined,"rules")');
    expect(settings).toContain('runSkillAnalysis([],undefined,"agent")');
    expect(settings).not.toContain("让 Agent 整理");
    expect(settings).not.toContain("未使用 Agent");
  });
  test("详情面板：技能包只登记；单引擎可纳管并部署；冲突可看差异、选一版", () => {
    const detail = settings.slice(settings.indexOf("function skillDetailHtml"), settings.indexOf("function proposalObs("));
    expect(detail).toContain("技能包");
    expect(detail).toContain("纳管并部署到");
    expect(detail).toContain("data-conflict-diff=");
    expect(detail).toContain("data-adopt-one=");
    expect(detail).toContain("以 ${esc(obs.engine)} 这一版为准");
  });
  test("部署到多根引擎时按另一侧所在的根原地换链接，否则唯一根直用、多根才弹选择", () => {
    const fn = settings.slice(settings.indexOf("async function resolveExpose"), settings.indexOf("async function showConflictDiff"));
    expect(fn).toContain("targetRootId(engine,hintPathByEngine[engine])");
    expect(fn).toContain("roots.length===1");
    expect(fn).toContain("data-root-choice");
  });
});

// 2026-09-04：整理建议页把 15 个冲突列成提示，却让用户「去目录筛冲突再点 Agent」——差异视图和
// 「以一版为准」昨天只接在目录详情里。冲突提示就该原地可处理。
describe("冲突提示就地可处理", () => {
  test("CONTENT_CONFLICT 卡片带差异按钮和选边按钮，技能包那一侧不给按钮", () => {
    expect(settings).toContain("function conflictNoteActions(note)");
    const fn = settings.slice(settings.indexOf("function conflictNoteActions"), settings.indexOf("function skillHistoryHtml"));
    expect(fn).toContain('note.code!=="CONTENT_CONFLICT"');
    expect(fn).toContain("data-conflict-diff=");
    expect(fn).toContain("data-adopt-one=");
    const sides = settings.slice(settings.indexOf("function conflictSides"), settings.indexOf("async function showConflictDiff"));
    expect(sides).toContain("!(o.nestedSkills>0)");                 // 技能包不能被选为准（planner 会拒）
    expect(settings).toContain("${conflictNoteActions(note)}");    // 真渲染进卡片了
  });
  test("空态文案不再把用户支去目录和 Agent", () => {
    const empty = settings.slice(settings.indexOf("function proposalEmptyText"), settings.indexOf("function analysisStale"));
    expect(empty).not.toContain("允许 Agent 查看此冲突文本");
    expect(empty).toContain("查看两侧差异");
  });
  test("差异视图按观测 id 工作，目录和建议页共用", () => {
    expect(settings).toContain("async function showConflictDiff(ids,returnEl)");
    expect(settings).toContain('showConflictDiff(b.dataset.conflictDiff.split(","),b)');
  });
});

// 2026-09-04：daemon 重启后 GET /api/skills 是 404、Settings.skills 为 null；注册表已解耦仍会加载，
// 目录里于是列出 45 个已纳管 Skill，选中一个渲染详情就撞上 Settings.skills.adapters 空指针——
// renderSettings() 抛异常，loadSkills 在发出扫描请求之前就死了，「开始只读扫描」点了没反应。
// 渲染路径必须能在没有扫描结果时跑完；点击处理器可以假定有数据，渲染不行。
test("渲染函数里不许直接解引用 Settings.skills", () => {
  const start = settings.indexOf("function renderSkills("), end = settings.indexOf("function bindSkillControls(");
  const render = settings.slice(start, end);
  expect(render).not.toMatch(/Settings\.skills\.\w/);
  expect(settings).toContain("Settings.skills?.adapters");
});

// 同一方案执行失败回滚后再提交会撞 TRANSACTION_CONFLICT（transactionId 已用掉）——要说清并作废方案；
// 操作记录里失败事务要露出错误码，不然「rolled-back」三个字什么都说明不了。
test("执行撞 TRANSACTION_CONFLICT 时作废方案并解释；操作记录显示错误码", () => {
  const apply = settings.slice(settings.indexOf("async function applySkillPlan"), settings.indexOf("async function currentInventory"));
  expect(apply).toContain('error.code==="SKILL_TRANSACTION_CONFLICT"');
  expect(apply).toContain("Settings.plan=null");
  expect(apply).toContain("重新点「审阅」");
  const history = settings.slice(settings.indexOf("function skillHistoryHtml"), settings.indexOf("function bindSkillControls"));
  expect(history).toContain("tx.errorCode");
});
