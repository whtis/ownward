// 自动角色：角色不再靠人手建、手维护。
//   · 打开项目 = 往一个 git 仓库派任务（或在派发弹窗里选中它）→ 没有 Owner 就建一个
//     （type=project，主项目 = 这个仓库在 vault 里的 slug，dirs = 仓库主检出目录）；
//   · 一次任务跨了几个项目、又没有现成角色同时管它们 → 提示建一个跨项目角色
//     （type=lead，关联这几个项目，dirs = 各自的仓库目录），由人点头才建；
//   · 角色的记忆就是项目的记忆：README / 决策 / 运维 + 收割自动写进 log/ 的工作日志——
//     任务结束 harvest 会往主项目 log/ 追加一条，下次同一个角色接手就读得到。
//     角色自己的 principles/decisions/backlog 照旧只走候选 + 人工晋升（审批门一道都不动）。
//
//   · 没有仓库的活（~/workspace、~ 下干的：飞书文档、客户档案、手机运维、本机排障…）归「领域角色」
//     （origin=domain，见 roles.ts V4）：主目录不是仓库时，「自动」按任务描述匹配一个领域角色；
//     有把握才替人选，拿不准就让人手选（预览给候选，派发时不替人挑）。领域角色由人点头才建。
//
// 边界（都是故意的）：
//   · 项目 Owner 只给 git 仓库配；领域角色永远不会被当成某个仓库的 Owner（虚拟项目不是仓库）；
//   · 人建的角色只读不改：自动维护（补工作目录、补别名项目）只碰 origin=auto 的；
//   · 归档 = 「这个项目不要 Owner」：不会自动再建一个顶替，要用就去角色页恢复；
//   · 跨 work/private 的项目合不成一个角色（scope 物理隔离，与 roles.ts 同一条约束）。
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { isWithin } from "./path-within.ts";
import { projectsDir, type Scope } from "./paths.ts";
import { projectIdentity, type ProjectIdentity } from "./project-identity.ts";
import { domainReadme, isDomainReadme, recentLogTitles } from "./project-knowledge.ts";
import { ensureProjectHome } from "./project-memory.ts";
import { wrapRoleContext } from "./role-context.ts";
import {
  activeVault, createRole, listRoles, resolveRole, roleIdInUse, roleKindLabel, roleMemoryPack, ROLE_ID_RE, updateRole,
  type Fail, type Result, type Role,
} from "./roles.ts";
import { cfg, DATA, log } from "./util.ts";

const fail = (code: Fail["code"], msg: string): Fail => ({ ok: false, code, msg });
/** tsconfig 关了 strict，判别式联合不会自动收窄——同 roles.ts，用显式守卫 */
const isFail = (v: unknown): v is Fail => !!v && (v as any).ok === false;

// ---- 可注入的项目身份解析、数据根与领域匹配模型（只给单测用：生产恒为 git + vault.workRemoteMatch、DATA、llmJson） ----
const realResolver = (dir: string) => projectIdentity(dir);
let identityOf: (dir: string) => ProjectIdentity | null = realResolver;
let dataRoot = DATA;
/** 领域匹配的模型调用：输入 prompt，输出解析好的 JSON（失败/超时给 null） */
export type DomainLlm = (prompt: string) => Promise<any | null>;
// 弹窗边打字边预览，一次派发可能问好几轮：用 llm.roleMatchModel（默认 haiku），别占决策模型的额度
const realLlm: DomainLlm = async (prompt) => (await import("./llm.ts")).llmJson(prompt, { timeoutMs: 45_000, quiet: true, model: cfg.llm?.roleMatchModel || "haiku" });
let domainLlm: DomainLlm = realLlm;
/** 单测注入假的「目录 → 项目身份」、临时数据根、假模型与派发等待上限；传 null 恢复生产。业务代码永远不要调用。 */
export function useRoleAutoForTest(opts: { identity?: (dir: string) => ProjectIdentity | null; dataRoot?: string; llm?: DomainLlm; dispatchWaitMs?: number; previewWaitMs?: number } | null) {
  identityOf = opts?.identity ?? realResolver;
  dataRoot = opts?.dataRoot ?? DATA;
  domainLlm = opts?.llm ?? realLlm;
  dispatchWaitMs = opts?.dispatchWaitMs ?? DISPATCH_MATCH_WAIT_MS;
  previewWaitMs = opts?.previewWaitMs ?? PREVIEW_MATCH_WAIT_MS;
  matchCache.clear();
  matchInflight.clear();
  matchRunning = 0;
  matchQueue.length = 0;
}

/** vault 本身（及其里面的仓库）不是项目：vault 常常就是个 git 仓库，任务把它加成附加目录时
 *  会被认成「tis-brain」这种项目，再配一个 Owner、拉一个「ownward + tis-brain」跨项目角色——
 *  记忆仓库给自己配角色，读的是一个不存在的 projects/<vault 名>/。2026-10 生产数据里实撞。 */
function projectOf(dir: string): ProjectIdentity | null {
  const id = identityOf(dir);
  if (!id) return null;
  // 两种写法都比：项目根是 realpath，配置里的 vault 根可能经过软链（macOS 的 /var → /private/var 就是一例）
  const raw = activeVault().root;
  let real = raw;
  try { real = realpathSync(raw); } catch { /* vault 还没建：按原路径比 */ }
  return isWithin(raw, id.root) || isWithin(real, id.root) ? null : id;
}

/** 与 web/roles.js 的 ROLE_COLORS 同一组：自动角色按 slug 稳定取色，同一个项目每次都是同一个颜色 */
const COLORS = ["#5b8def", "#4fb391", "#c07ae0", "#e0925b", "#e06b7a", "#4fb0c0", "#9a8ce0", "#7f8a99"];
function colorFor(key: string): string {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

const scopeName = (s: Scope) => (s === "work" ? "工作" : s === "private" ? "私人" : "根");
/** roles.ts 按字计长度：名字/描述超了会被整份拒，这里先按字截好 */
function fit(s: string, max: number): string {
  const a = [...s];
  return a.length > max ? a.slice(0, max - 1).join("") + "…" : s;
}

function idBase(prefix: string, parts: string[]): string {
  const body = parts.map((p) => p.replace(/[^a-z0-9-]+/g, "-")).join("-");
  return `${prefix}-${body}`.replace(/-+/g, "-").slice(0, 36).replace(/-+$/, "");
}
/** id 是跨 scope 的全局主键：撞了就加序号，绝不覆盖（roleIdInUse 连坏掉的 role.json 也算占用） */
function freeId(base: string): string | null {
  for (let i = 1; i <= 9; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    if (ROLE_ID_RE.test(id) && !roleIdInUse(id)) return id;
  }
  return null;
}

/** 同一个项目只算一次（worktree、子目录、重复传参都会造出重复项） */
function uniq(ids: ProjectIdentity[]): ProjectIdentity[] {
  const seen = new Set<string>();
  return ids.filter((x) => {
    const k = `${x.scope}|${x.slug}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 别名项目只在 vault 里真有目录时才关联：否则角色挂一串读不到东西的空名字 */
function existingAliases(id: ProjectIdentity): string[] {
  const base = projectsDir(id.scope, activeVault().root);
  return id.aliases.filter((a) => a !== id.slug && existsSync(join(base, a)));
}

/** 角色管不管这个项目：关联项目或曾用名里有它（或它的别名）——改名前的老仓库也算在现在的 Owner 名下 */
const covers = (r: Role, id: ProjectIdentity) => {
  const keys = [id.slug, ...id.aliases];
  return keys.some((k) => r.projects.includes(k) || r.history.includes(k));
};

// ---- 查询 ----
/** 这个项目的 Owner：同 scope、type=project、主项目是 slug（或它的别名，人建的专家常按远程名起）。
 *  在岗的优先；只剩归档的也交出来——调用方要据此判断「人不要这个 Owner 了」。
 *  改过名的项目：主项目对不上、但某个在岗项目角色的曾用名里有它（cockpit → ownward），那个角色就是 Owner——
 *  老仓库的 Owner 归档了也照样有人接。领域角色不参与：它的主项目是虚拟项目，永远不是哪个仓库的 Owner */
export function findProjectOwner(id: ProjectIdentity, roles: Role[] = listRoles({ includeArchived: true })): { active?: Role; archived?: Role } {
  const keys = new Set([id.slug, ...id.aliases]);
  const mine = roles.filter((r) => r.scope === id.scope && r.type === "project" && r.origin !== "domain" && keys.has(r.primaryProject));
  const rank = (r: Role) => (r.primaryProject === id.slug ? 0 : 1);
  const active = mine.filter((r) => r.status === "active").sort((a, b) => rank(a) - rank(b))[0]
    ?? roles.find((r) => r.scope === id.scope && r.type === "project" && r.origin !== "domain" && r.status === "active"
      && [...keys].some((k) => r.history.includes(k)));
  return {
    active,
    archived: mine.filter((r) => r.status !== "active").sort((a, b) => rank(a) - rank(b) || (a.updatedAt < b.updatedAt ? 1 : -1))[0],
  };
}

/** 现成的、同时管这几个项目的在岗角色（同 scope、无冲突）。多个时挑多余项目最少的——最贴这次任务 */
export function findCoveringRole(scope: Scope, ids: ProjectIdentity[], roles: Role[] = listRoles()): Role | null {
  const hits = roles.filter((r) => r.scope === scope && r.status === "active" && !r.conflict && ids.every((id) => covers(r, id)));
  hits.sort((a, b) => (a.projects.length - b.projects.length) || (a.type === b.type ? 0 : a.type === "lead" ? -1 : 1));
  return hits[0] ?? null;
}

// ---- 建与维护 ----
const OWNER_INSTRUCTIONS = (label: string) => [
  `负责 ${label} 的端到端交付：弄清现状、实现、验证，守住已知陷阱和既有决策。`,
  "开工前先看项目记忆（README / 决策 / 近期工作日志）；记忆可能过时，与代码、命令输出冲突时以事实为准。",
  "做完在最后的回复里单列「值得记住的」：新踩的坑、拍板的决定、部署与排障方式——会被收割进项目日志，下次接手就读得到。",
].join("\n");

const CROSS_INSTRUCTIONS = (labels: string[]) => [
  `负责 ${labels.join("、")} 之间的跨项目工作：接口与数据约定、联动改动、发布先后顺序。`,
  "每个项目自己的事实以各自的项目记忆为准；拿不准改动会波及哪边时，先说出来再动手。",
  "做完在最后的回复里单列「值得记住的」，会被收割进项目日志。",
].join("\n");

/** Owner 的名字用远程仓库名（比目录名有辨识度）；但一个远程可能有好几份检出（internal / ownward-public
 *  都叫 ownward），撞名时补上目录名，免得列表里出现两个一模一样的「ownward Owner」 */
function ownerName(id: ProjectIdentity, roles: Role[]): string {
  const base = `${id.label} Owner`;
  const clash = id.label.toLowerCase() !== id.slug && roles.some((r) => r.name === base);
  return fit(clash ? `${id.label}（${id.slug}）Owner` : base, 30);
}

/** 跨项目角色的默认名：放得下就全列；三个以上放不下时退成「a + b 等 N 个项目」，再放不下「a 等 N 个项目」——
 *  宁可少列一个名字，也别截成「acme-app + orbit-service 等 3 …」这种半句话 */
export function defaultCrossName(labels: string[]): string {
  const all = labels.join(" + ");
  if (labels.length <= 2 || [...all].length <= 30) return fit(all, 30);
  const two = `${labels[0]} + ${labels[1]} 等 ${labels.length} 个项目`;
  return [...two].length <= 30 ? two : fit(`${labels[0]} 等 ${labels.length} 个项目`, 30);
}

/** 自动维护只碰 Ownward 自己建的：补上这次看到的工作目录、vault 里新冒出来的别名项目。
 *  维护失败不影响使用（照旧返回原角色），但要留痕 */
function maintain(role: Role, id: ProjectIdentity): Role {
  if (role.origin !== "auto") return role;
  const dirs = role.dirs.includes(id.root) ? role.dirs : [...role.dirs, id.root].slice(0, 20);
  const projects = [...new Set([...role.projects, ...existingAliases(id)])].slice(0, 20);
  if (dirs.length === role.dirs.length && projects.length === role.projects.length) return role;
  const r = updateRole(role.id, { dirs, projects });
  if (isFail(r)) { log(`role-auto: 维护 ${role.id} 失败（不影响这次使用）：${r.msg}`); return role; }
  log(`role-auto: 更新了 ${role.id} 的工作目录/关联项目`);
  return { ...role, ...r.role };
}

/** 项目的 Owner：有就用（自动建的顺手维护），没有就建；人归档过的不自动顶替 */
export function ensureProjectOwner(id: ProjectIdentity): Result<{ role: Role; created: boolean }> {
  if (!activeVault().scopes.includes(id.scope)) return fail("invalid", `项目 ${id.slug} 属于 ${scopeName(id.scope)}，当前 vault 没有这个分流`);
  const found = findProjectOwner(id);
  if (found.active) {
    if (found.active.conflict) return fail("conflict", found.active.conflictMsg || `项目 ${id.slug} 的 Owner 有歧义`);
    // 靠曾用名认领的老仓库（cockpit 归 ownward Owner）不做维护：把老仓库登记成工作目录，
    // 以后「派任务给它」就会把早已停更的老仓库当附加目录一起带上
    const own = [id.slug, ...id.aliases].includes(found.active.primaryProject);
    return { ok: true, role: own ? maintain(found.active, id) : found.active, created: false };
  }
  if (found.archived) {
    return fail("invalid", `项目 ${id.slug} 的 Owner「${found.archived.name}」已归档——要用就去角色页恢复它`);
  }
  const home = ensureProjectHome(id.slug, id.scope);
  if (isFail(home)) return home;
  const roleId = freeId(idBase("owner", [id.slug]));
  if (!roleId) return fail("conflict", `给 ${id.slug} 起不出空闲的角色 id（owner-${id.slug} 及其序号都被占了）`);
  const r = createRole({
    id: roleId, scope: id.scope,
    name: ownerName(id, listRoles({ includeArchived: true })),
    description: fit(`${id.label} 的项目负责人：派到这个仓库的任务默认由它接`, 200),
    icon: "code", color: colorFor(id.slug),
    type: "project", primaryProject: id.slug, projects: [id.slug, ...existingAliases(id)],
    dirs: [id.root], origin: "auto",
    instructions: OWNER_INSTRUCTIONS(id.label),
  });
  if (isFail(r)) {
    // 并发：两个派发同时给同一个新项目建 Owner，后到的撞上「一个项目只留一个在岗专家」——用先到的那个
    const again = findProjectOwner(id).active;
    if (r.code === "conflict" && again && !again.conflict) return { ok: true, role: again, created: false };
    return r;
  }
  log(`role-auto: 给 ${id.scope ? id.scope + "/" : ""}${id.slug} 建了项目 Owner ${r.role.id}`);
  return { ok: true, role: r.role, created: true };
}

/** 跨项目角色：已有同时管这几个项目的角色就直接用，没有才建。这是「人点头之后」才调用的 */
export function ensureCrossRole(input: ProjectIdentity[], opts: { name?: string } = {}): Result<{ role: Role; created: boolean }> {
  const ids = uniq(input).sort((a, b) => (a.slug < b.slug ? -1 : 1));
  if (ids.length < 2) return fail("invalid", "跨项目角色至少要两个不同的项目");
  const scopes = [...new Set(ids.map((x) => x.scope))];
  if (scopes.length > 1) {
    return fail("invalid", `这几个项目分属${scopes.map(scopeName).join("和")}，合不成一个角色（工作和私人的记忆不能串）`);
  }
  const scope = scopes[0];
  if (!activeVault().scopes.includes(scope)) return fail("invalid", `这些项目属于 ${scopeName(scope)}，当前 vault 没有这个分流`);
  const covering = findCoveringRole(scope, ids);
  if (covering) return { ok: true, role: covering, created: false };
  for (const id of ids) {
    const h = ensureProjectHome(id.slug, scope);
    if (isFail(h)) return h;
  }
  const labels = ids.map((x) => x.label);
  const roleId = freeId(idBase("cross", ids.map((x) => x.slug)));
  if (!roleId) return fail("conflict", "起不出空闲的角色 id，换个名字或先归档旧的跨项目角色");
  const r = createRole({
    id: roleId, scope,
    name: fit(String(opts.name ?? "").trim().replace(/\s+/g, " ") || defaultCrossName(labels), 30),
    description: fit(`同时管 ${labels.join("、")}：跨这几个项目的任务由它接`, 200),
    icon: "product", color: colorFor(ids.map((x) => x.slug).join("+")),
    type: "lead", projects: [...new Set(ids.flatMap((id) => [id.slug, ...existingAliases(id)]))].slice(0, 20),
    dirs: ids.map((x) => x.root), origin: "auto",
    instructions: CROSS_INSTRUCTIONS(labels),
  });
  if (isFail(r)) return r;
  log(`role-auto: 建了跨项目角色 ${r.role.id}（${ids.map((x) => x.slug).join(" + ")}）`);
  return { ok: true, role: r.role, created: true };
}

/** 角色页「为这个目录生成 Owner」/ 派发前预建：目录 → 项目身份 → Owner */
export function ensureOwnerForDir(dir: string): Result<{ role: Role; created: boolean }> {
  const id = projectOf(dir);
  if (!id) return fail("invalid", "这个目录不是 git 仓库（或是 vault 本身），没有项目身份（Owner 只给仓库配）");
  return ensureProjectOwner(id);
}

export function crossRoleForDirs(dirs: string[], name?: string): Result<{ role: Role; created: boolean }> {
  const ids: ProjectIdentity[] = [];
  const bad: string[] = [];
  for (const d of dirs) {
    const id = projectOf(d);
    if (id) ids.push(id); else bad.push(String(d).split("/").filter(Boolean).pop() || String(d));
  }
  if (bad.length) return fail("invalid", `这些目录不是 git 仓库，没有项目身份：${bad.join("、").slice(0, 120)}`);
  return ensureCrossRole(ids, { name });
}

// ---- 领域角色：没有仓库的那类活 ----
/** 英文短名：比项目 slug 更窄（不许点和下划线），短到能看出是什么 */
const DOMAIN_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
/** 虚拟项目的目录名 = domain-<短名>：仓库的项目 slug 是目录名，起成同名（比如真有个叫 toolchain 的仓库）
 *  就会互相顶——仓库建不出 Owner、它的日志还会记进领域角色的虚拟项目。带前缀就撞不上 */
const domainProject = (slug: string) => (slug.startsWith("domain-") ? slug : `domain-${slug}`);

const DOMAIN_INSTRUCTIONS = (name: string) => [
  `负责「${name}」这一类没有代码仓库的工作：弄清现状、动手处理、把结论留下来。`,
  "开工前先看这个领域的记忆（现状 / 决策 / 近期工作日志）；记忆可能过时，与命令输出、文档原文冲突时以事实为准。",
  "做完在最后的回复里单列「值得记住的」：新踩的坑、拍板的决定、常用的操作步骤——会被收割进这个领域的日志，下次接手就读得到。",
].join("\n");

/** 在岗、无冲突的领域角色（所有 scope）：派发匹配与收割归属的候选池 */
export function listDomainRoles(roles: Role[] = listRoles()): Role[] {
  return roles.filter((r) => r.origin === "domain" && r.status === "active" && !r.conflict);
}

export interface DomainInput {
  name: string; scope: Scope;
  /** 英文短名（虚拟项目目录是 domain-<短名>）；不给就按时间起一个 */
  slug?: string;
  /** 这类活包括什么：写进角色描述和虚拟项目 README 的「现状」 */
  description?: string;
  /** 派任务给它时的默认目录（一般是 ~/workspace） */
  dirs?: string[];
}

/** 建领域角色（人点头之后才调）：同 scope 已有同名虚拟项目的领域角色就直接用。
 *  vault 里已经有同名项目目录、又不是领域角色建的（某个仓库的收割记录）——拒绝，不能拿别人的项目当虚拟项目 */
export function ensureDomainRole(input: DomainInput): Result<{ role: Role; created: boolean }> {
  const name = fit(String(input?.name ?? "").trim().replace(/\s+/g, " "), 30);
  if (!name) return fail("invalid", "领域角色要有名字");
  const scope = input?.scope ?? "";
  if (!activeVault().scopes.includes(scope)) return fail("invalid", `scope 只能是 ${activeVault().scopes.map((s) => s || "(不分流)").join(" / ")}`);
  const short = String(input?.slug ?? "").trim().toLowerCase() || Date.now().toString(36);
  if (!DOMAIN_SLUG_RE.test(short)) return fail("invalid", "英文短名只能是小写字母/数字/连字符，2–31 位");
  const slug = domainProject(short);
  const description = String(input?.description ?? "").trim();

  const same = listRoles({ includeArchived: true }).find((r) => r.scope === scope && r.type === "project" && r.primaryProject === slug);
  if (same) {
    if (same.origin !== "domain") return fail("conflict", `${slug} 已经是「${same.name}」的主项目，换个英文短名`);
    if (same.status !== "active") return fail("invalid", `领域角色「${same.name}」已归档——要用就去角色页恢复`);
    if (same.conflict) return fail("conflict", same.conflictMsg || `领域角色「${same.name}」有歧义`);
    return { ok: true, role: same, created: false };
  }
  // 建目录 / 复核已有目录都走 ensureProjectHome：slug 白名单、projects/ 前缀与软链复核都在里面
  const h = ensureProjectHome(slug, scope);
  if (isFail(h)) return h;
  const readme = join(h.dir, "README.md");
  if (h.created) {
    // 新建的是仓库项目的骨架：换成领域版（多一行 kind: domain，标题用中文名，现状写这类活包括什么）
    writeFileSync(readme, domainReadme(name, slug, scope, description, new Date().toISOString().slice(0, 10)));
  } else {
    let text = "";
    try { text = readFileSync(readme, "utf8"); } catch { /* 没 README 也算别人的目录 */ }
    if (!isDomainReadme(text)) return fail("conflict", `vault 里已经有项目 ${slug}（不是领域角色建的），换个英文短名`);
  }
  const roleId = freeId(slug);
  if (!roleId) return fail("conflict", `给 ${slug} 起不出空闲的角色 id`);
  const r = createRole({
    id: roleId, scope, name,
    description: fit(description || `${name}：没有代码仓库的这类活由它接`, 200),
    icon: "ops", color: colorFor(slug),
    type: "project", primaryProject: slug, projects: [slug],
    dirs: input?.dirs ?? [], origin: "domain",
    instructions: DOMAIN_INSTRUCTIONS(name),
  });
  if (isFail(r)) return r;
  log(`role-auto: 建了领域角色 ${r.role.id}（${scope ? scope + "/" : ""}${slug}）`);
  return { ok: true, role: r.role, created: true };
}

/** 按内容匹配领域角色的结果。四种情况处理方式不同，别糊成一个「有/没有」：
 *    matched   —— 有把握：派发时直接由它接；
 *    none      —— 明显哪个都不像：不带角色，也不用问人；
 *    uncertain —— 拿不准：预览把候选给人手选，派发时（没人可问）不替人挑；
 *    failed    —— 模型没给出结果：同 uncertain，但原因要如实说 */
export interface DomainMatch {
  /** pending：只在调用方给了 waitMs 时出现——模型还没判完，结果会照常进缓存，这一次先不等 */
  kind: "matched" | "none" | "uncertain" | "failed" | "pending";
  role?: Role;
  candidates: Role[];
  why: string;
}

const MATCH_TTL_MS = 30 * 60_000;
/** 预览和真派发是同一段任务描述：缓存住，派发那一下不用再等一次模型 */
const matchCache = new Map<string, { at: number; v: DomainMatch }>();
const matchInflight = new Map<string, Promise<DomainMatch>>();
/** 模型看到的就是这么长：缓存也按这一截算（预览截 4000、派发不截，按全文算 key 会白白再问一次） */
const MATCH_TEXT_MAX = 2000;
/** 同时最多几个匹配在问模型：弹窗每停顿一下就是一次预览，被顶掉的那次不会中止，得给并发封个顶 */
const MATCH_CONCURRENCY = 3;
let matchRunning = 0;
const matchQueue: Array<() => void> = [];
async function withMatchSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (matchRunning >= MATCH_CONCURRENCY) await new Promise<void>((r) => matchQueue.push(r));
  matchRunning++;
  try { return await fn(); } finally { matchRunning--; matchQueue.shift()?.(); }
}
/** 描述留空时客户端会补一句「待命开场」（web/手机同一句）：那不是任务描述，不拿去匹配 */
const STANDBY_RE = /^你是常驻结对助手。本条只是开场/;

function domainPrompt(text: string, domains: Role[]): string {
  const lines = domains.map((r) => {
    const recent = recentLogTitles(projectsDir(r.scope, activeVault().root), r.primaryProject, 8);
    return [
      `- id: ${r.id} · 名字：${r.name} · ${r.scope === "work" ? "工作" : r.scope === "private" ? "私人" : "不分流"}`,
      `  说明：${r.description || "（无）"}`,
      ...(recent.length ? [`  近期的活：${recent.join("；")}`] : []),
    ].join("\n");
  });
  return [
    "你在给一段工作挑接手的「领域角色」。这段工作发生在工作区根目录（不是某个代码仓库），要按内容判断它属于哪一类活。",
    "只在很有把握时给出 roleId；拿不准就把 confidence 设为 low，并按可能性列出 1–3 个候选；明显哪个都不像，就 roleId 留空、confidence 设为 high、candidates 留空。",
    "工作和私人的边界要守住：拿不准是公事还是私事时一律算拿不准，不要硬选。",
    `输出严格 JSON：{"roleId": "<下面列表里的 id，或空串>", "confidence": "high 或 low", "candidates": ["<id>"], "why": "<一句话依据，40 字以内>"}`,
    "",
    "=== 领域角色 ===",
    ...lines,
    "",
    "=== 这段工作 ===",
    text.slice(0, MATCH_TEXT_MAX),
  ].join("\n");
}

/** 模型输出 → DomainMatch：id 必须在候选池里（模型编出来的 id 一律丢），其余按上面四种情况归类 */
export function parseDomainMatch(raw: any, domains: Role[]): DomainMatch {
  if (!raw || typeof raw !== "object") return { kind: "failed", candidates: domains, why: "模型没给出结果" };
  const byId = new Map(domains.map((r) => [r.id, r]));
  const why = String(raw.why ?? "").trim().slice(0, 80);
  const rawId = String(raw.roleId ?? "").trim();
  const pick = byId.get(rawId);
  const listed = (Array.isArray(raw.candidates) ? raw.candidates : [])
    .map((x: unknown) => byId.get(String(x ?? "").trim())).filter((x: Role | undefined): x is Role => !!x);
  const sure = String(raw.confidence ?? "").trim().toLowerCase() === "high";
  if (pick && sure) return { kind: "matched", role: pick, candidates: [], why };
  // 「都不像」只认明确留空的 roleId：说「很有把握」却给了一个不存在的 id，是答坏了，按拿不准处理
  if (!rawId && sure && !listed.length) return { kind: "none", candidates: [], why };
  const cands = [...new Set([...(pick ? [pick] : []), ...listed])].slice(0, 3);
  return { kind: "uncertain", candidates: cands.length ? cands : domains, why };
}

/** 一段工作该归哪个领域角色（派发预览、真派发、收割归属共用）。没有领域角色 / 没有内容 / 待命开场 → none。
 *  opts.waitMs：最多等这么久（真派发用：/api/work 不能被模型拖过手机的 20s 超时）；没判完就回 pending，
 *  那次调用照常跑完进缓存——人重派、或收割归属时就有结果了 */
export async function matchDomain(text: string, domains: Role[] = listDomainRoles(), opts: { waitMs?: number } = {}): Promise<DomainMatch> {
  const t = String(text ?? "").trim().slice(0, MATCH_TEXT_MAX);
  if (!t || STANDBY_RE.test(t) || !domains.length) return { kind: "none", candidates: [], why: "" };
  // 角色改了名字/说明就重新判：指纹里带 updatedAt
  const key = createHash("sha1").update(t).update("\u0000").update(domains.map((r) => `${r.id}@${r.updatedAt}`).join(",")).digest("hex");
  const hit = matchCache.get(key);
  if (hit && Date.now() - hit.at < MATCH_TTL_MS) return hit.v;
  // 弹窗边打字边预览、紧接着点派发：同一段描述同时只问一次模型，后来的等前面那次的结果
  let job = matchInflight.get(key);
  if (!job) {
    job = withMatchSlot(async () => {
      let raw: any = null;
      try { raw = await domainLlm(domainPrompt(t, domains)); } catch (e) { log(`role-auto: 领域匹配调用失败：${String(e).slice(0, 160)}`); }
      const v = parseDomainMatch(raw, domains);
      // 失败不缓存：下一次（比如真派发那一下）还有机会判出来
      if (v.kind !== "failed") {
        matchCache.set(key, { at: Date.now(), v });
        if (matchCache.size > 200) matchCache.delete(matchCache.keys().next().value!);
      }
      return v;
    }).finally(() => { if (matchInflight.get(key) === job) matchInflight.delete(key); });
    matchInflight.set(key, job);
  }
  if (opts.waitMs === undefined) return job;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<DomainMatch>((r) => { timer = setTimeout(() => r({ kind: "pending", candidates: domains, why: "" }), opts.waitMs); });
  try { return await Promise.race([job, late]); } finally { clearTimeout(timer); }
}

// ---- 派发：预览（弹窗用，无副作用）与绑定（真派发时） ----
export interface DirProject {
  dir: string;
  /** 不是仓库就没有下面这些 */
  root?: string; scope?: Scope; slug?: string; label?: string;
  ownerId?: string; ownerName?: string; ownerArchived?: boolean;
}
export interface RolePreview {
  projects: DirProject[];
  /** 「自动」会落到谁：现成角色 / 将新建的 Owner / 谁都不（reason 说为什么）。
   *  by="task"：主目录不是仓库，按任务描述匹配领域角色——客户端据此把任务描述带进预览请求；
   *  needsTask：还没写任务描述；candidates：拿不准，让人从这几个里手选（派发时 auto 不会替人挑）；
   *  why：匹配上的一句依据 */
  auto: {
    roleId: string; name: string; willCreate: boolean; reason: string;
    by?: "task"; needsTask?: boolean; candidates?: Array<{ id: string; name: string }>; why?: string;
    /** by=task 且模型这会儿还没判完（预览不等太久）：客户端照常可派，派发时服务端会再判一次 */
    pending?: boolean;
  };
  /** 跨了 ≥2 个项目且没有现成角色同时管它们：给弹窗问「要不要建跨项目角色」 */
  cross: null | { possible: boolean; reason: string; name: string; labels: string[]; slugs: string[]; dirs: string[] };
}

const autoOff = () => cfg.dispatch?.autoRole === false;

export function previewRoleForDirs(dir: string, extraDirs: string[] = []): RolePreview {
  const roles = listRoles({ includeArchived: true });
  const active = roles.filter((r) => r.status === "active");
  const rows = [dir, ...extraDirs].map((d) => ({ d, id: projectOf(d) }));
  const projects: DirProject[] = rows.map(({ d, id }) => {
    if (!id) return { dir: d };
    const o = findProjectOwner(id, roles);
    const owner = o.active ?? o.archived;
    return {
      dir: d, root: id.root, scope: id.scope, slug: id.slug, label: id.label,
      ...(owner ? { ownerId: owner.id, ownerName: owner.name, ownerArchived: owner.status !== "active" } : {}),
    };
  });
  const primary = rows[0]?.id ?? null;
  const ids = uniq(rows.map((r) => r.id).filter((x): x is ProjectIdentity => !!x));
  let auto: RolePreview["auto"] = { roleId: "", name: "", willCreate: false, reason: "" };
  let cross: RolePreview["cross"] = null;

  if (ids.length >= 2) {
    const scopes = [...new Set(ids.map((x) => x.scope))];
    const labels = ids.map((x) => x.label);
    const covering = scopes.length === 1 ? findCoveringRole(scopes[0], ids, active) : null;
    if (covering) auto = { roleId: covering.id, name: covering.name, willCreate: false, reason: "现成角色同时管这几个项目" };
    else cross = {
      possible: scopes.length === 1,
      reason: scopes.length === 1 ? "" : `这几个项目分属${scopes.map(scopeName).join("和")}，合不成一个角色`,
      name: defaultCrossName(labels), labels, slugs: ids.map((x) => x.slug), dirs: ids.map((x) => x.root),
    };
  }
  if (!auto.roleId) {
    if (!primary) auto.reason = "主目录不是 git 仓库（或是 vault 本身），没有项目 Owner";
    else {
      const o = findProjectOwner(primary, roles);
      if (o.active?.conflict) auto.reason = o.active.conflictMsg || "这个项目的 Owner 有歧义";
      else if (o.active) auto = { roleId: o.active.id, name: o.active.name, willCreate: false, reason: "" };
      else if (o.archived) auto.reason = `Owner「${o.archived.name}」已归档`;
      else auto = { roleId: "", name: ownerName(primary, roles), willCreate: true, reason: "" };
    }
  }
  if (autoOff()) auto = { roleId: "", name: "", willCreate: false, reason: "已关闭自动角色（config dispatch.autoRole）" };
  return { projects, auto, cross };
}

const roleRef = (r: Role) => ({ id: r.id, name: r.name });

/** 派发弹窗的完整预览：主目录是仓库 → 同 previewRoleForDirs；不是仓库 → 按任务描述匹配领域角色 */
export async function previewRoleForDispatch(dir: string, extraDirs: string[] = [], task = ""): Promise<RolePreview> {
  const p = previewRoleForDirs(dir, extraDirs);
  if (autoOff() || p.auto.roleId || p.auto.willCreate || p.projects[0]?.root) return p;
  const domains = listDomainRoles();
  if (!domains.length) return { ...p, auto: { ...p.auto, reason: "主目录不是 git 仓库，也还没有领域角色——这次不带角色" } };
  const by = "task" as const;
  if (!String(task ?? "").trim()) {
    return { ...p, auto: { roleId: "", name: "", willCreate: false, reason: "主目录不是仓库：写好任务描述后按描述匹配领域角色", by, needsTask: true } };
  }
  const m = await matchDomain(task, domains, { waitMs: previewWaitMs });
  if (m.kind === "matched") return { ...p, auto: { roleId: m.role!.id, name: m.role!.name, willCreate: false, reason: "", by, why: m.why } };
  if (m.kind === "none") return { ...p, auto: { roleId: "", name: "", willCreate: false, reason: "不像任何一个领域角色的活，这次不带角色", by, why: m.why } };
  if (m.kind === "pending") {
    return { ...p, auto: { roleId: "", name: "", willCreate: false, by, pending: true, reason: "模型还在判断由哪个领域角色接，派发时会再判一次（也可以直接手选）" } };
  }
  return {
    ...p,
    auto: {
      roleId: "", name: "", willCreate: false, by, candidates: m.candidates.map(roleRef), why: m.why,
      reason: m.kind === "failed" ? "没判断出该由哪个领域角色接，手选一个" : "拿不准由哪个领域角色接，手选一个",
    },
  };
}

/** 真派发等领域匹配的上限：手机端 /api/work 读超时 20s，超时重试会派出重复任务 */
const DISPATCH_MATCH_WAIT_MS = 5000;
let dispatchWaitMs = DISPATCH_MATCH_WAIT_MS;
/** 预览等领域匹配的上限：同样要在手机的 20s 读超时之内回话——模型慢的时候让客户端先拿到「还在判断」，
 *  而不是超时报错（客户端会一直拦着「正在匹配」，人派不出去）。那次调用照常跑完进缓存 */
const PREVIEW_MATCH_WAIT_MS = 12_000;
let previewWaitMs = PREVIEW_MATCH_WAIT_MS;

export interface DispatchRole {
  role: Role | null;
  created: boolean;
  /** 自动匹配没成功的原因（不阻塞派发，但要让人看见——不许假成功） */
  note: string;
  /** 收割写日志用的项目 slug：项目角色的主项目（Owner 要与派发目录同 scope）、领域角色的虚拟项目；其余空串 */
  project: string;
  /** project 所在的 scope（收割按它分流）：领域角色的 scope 是建角色时定的，与派发目录无关 */
  scope?: Scope;
}

/** 派发时定角色。choice：auto（缺省）/ none / 角色 id。task：任务描述（主目录不是仓库时按它匹配领域角色）。
 *  显式选的角色不可用 → 抛（用户点名要它，悄悄换成别的或不带都是假成功）；
 *  auto 失败 → 不带角色照常派，原因写进 note；领域匹配拿不准 → 也不带（没人可问，不替人挑），原因进 note。 */
export async function pickRoleForDispatch(choice: string | undefined, dir: string, extraDirs: string[] = [], task = ""): Promise<DispatchRole> {
  const none: DispatchRole = { role: null, created: false, note: "", project: "" };
  const c = String(choice ?? "").trim() || "auto";
  if (c === "none") return none;
  if (c !== "auto") {
    const r = resolveRole(c);
    if (isFail(r)) throw Object.assign(new Error(`角色不可用：${r.msg}`), { code: "ROLE_UNAVAILABLE" });
    if (r.role.status !== "active") throw Object.assign(new Error(`角色 ${r.role.id} 已归档，先恢复再派任务给它`), { code: "ROLE_UNAVAILABLE" });
    if (r.role.origin === "domain") return { role: r.role, created: false, note: "", project: r.role.primaryProject, scope: r.role.scope };
    // 项目角色：派到它自己 scope 的仓库、或者派到根目录（没有项目身份可比）时，日志记进它的主项目——
    // 人点名要它接，这次的活就是它的；派到别的 scope 的仓库才按派发目录记（不跨 scope 写别人的项目）
    const here = projectOf(dir);
    const own = r.role.type === "project" && (!here || here.scope === r.role.scope);
    return { role: r.role, created: false, note: "", project: own ? r.role.primaryProject : "", ...(own ? { scope: r.role.scope } : {}) };
  }
  if (autoOff()) return none;
  const primary = projectOf(dir);
  if (!primary) {
    // 附加目录里的仓库正好有角色同时管：同预览（预览给人看的就是这个角色）
    const extras = uniq(extraDirs.map((d) => projectOf(d)).filter((x): x is ProjectIdentity => !!x));
    const scopes = [...new Set(extras.map((x) => x.scope))];
    if (extras.length >= 2 && scopes.length === 1) {
      const covering = findCoveringRole(scopes[0], extras);
      if (covering) return { role: covering, created: false, note: "", project: "" };
    }
    // 不是仓库：有领域角色、有任务描述才匹配；什么都匹配不上是正常情况，不算失败。
    // 派发不等模型太久：预览判过的直接命中缓存，没判过的最多等 5s，判不完就先不带
    const domains = listDomainRoles();
    if (!domains.length || !String(task ?? "").trim()) return none;
    const m = await matchDomain(task, domains, { waitMs: dispatchWaitMs });
    if (m.kind === "matched") return { role: m.role!, created: false, note: "", project: m.role!.primaryProject, scope: m.role!.scope };
    if (m.kind === "none") return none;
    const names = m.candidates.map((r) => `「${r.name}」`).join("、");
    const note = m.kind === "pending" ? "领域角色还在匹配（派发不等模型），这次不带角色"
      : m.kind === "failed" ? `领域角色没匹配出来（${m.why}），这次不带角色`
      : `拿不准由哪个领域角色接（像是${names}），这次不带角色——要带就在派发时手选`;
    log(`role-auto: ${note}`);
    return { ...none, note };
  }
  const ids = uniq([primary, ...extraDirs.map((d) => projectOf(d)).filter((x): x is ProjectIdentity => !!x)])
    .filter((x) => x.scope === primary.scope);
  if (ids.length >= 2) {
    const covering = findCoveringRole(primary.scope, ids);
    if (covering) return { role: covering, created: false, note: "", project: "" };
  }
  const owner = ensureProjectOwner(primary);
  if (isFail(owner)) {
    log(`role-auto: ${primary.slug} 没带上 Owner：${owner.msg}`);
    return { ...none, note: owner.msg };
  }
  // 靠曾用名认领的老仓库：日志照旧记在老项目名下（那是它的历史），Owner 通过曾用名读得到
  const own = [primary.slug, ...primary.aliases].includes(owner.role.primaryProject);
  return { role: owner.role, created: owner.created, note: "", project: own ? owner.role.primaryProject : primary.slug, scope: primary.scope };
}

/** 任务首条消息前面的那段角色记忆（信封格式见 role-context.ts） */
export function roleTaskContext(role: Role): string {
  const body = [
    `你在以「${role.name}」的身份接这个任务（${roleKindLabel(role)}）。下面是这个角色的长期记忆：vault 里的只读副本，可能过时——与代码、命令输出冲突时以事实为准，不必逐条复述。`,
    roleMemoryPack(role.id, undefined, { audience: "task" }).trim(),
    "做完后在最后的回复里单列「值得记住的」（新踩的坑、拍板的决定、部署与排障方式；没有就不写）：Ownward 会把它收割进项目日志，下次接手的人就读得到。",
  ].join("\n\n");
  const projects = role.type === "project" && role.primaryProject
    ? [role.primaryProject, ...role.projects.filter((p) => p !== role.primaryProject)]
    : role.projects;
  return wrapRoleContext({ id: role.id, name: role.name, projects }, body);
}

// ---- 跨项目建议（角色页顶部「要不要建个角色管它们」） ----
export interface RoleSuggestion {
  key: string; scope: Scope; slugs: string[]; labels: string[]; dirs: string[];
  /** 多少次任务/会话同时动过这几个项目 */
  count: number; lastAt: string; name: string;
}
const SUGGEST_FILE = () => join(dataRoot, "role-suggestions.json");
/** 时间一律按数值比：来源有任务 startedAt、会话 updatedAt、忽略时刻三种，别赌它们都是同一种 ISO 写法 */
const ms = (t: string) => Date.parse(t) || 0;
const KEY_RE = /^[a-z]*\|[a-z0-9._+-]{3,300}$/;

function readDismissed(): Record<string, string> {
  try {
    const v = JSON.parse(readFileSync(SUGGEST_FILE(), "utf8"));
    const d = v && typeof v === "object" ? v.dismissed : null;
    if (!d || typeof d !== "object" || Array.isArray(d)) return {};
    return Object.fromEntries(Object.entries(d as Record<string, unknown>)
      .filter((e): e is [string, string] => KEY_RE.test(e[0]) && typeof e[1] === "string"));
  } catch { return {}; }
}

/** 忽略一条建议：同样的组合之后又一起动了，建议会再回来（同「隐藏项目组」的习惯） */
export function dismissRoleSuggestion(key: string): Result<{ msg: string }> {
  const k = String(key ?? "");
  if (!KEY_RE.test(k)) return fail("invalid", "建议 key 不合法");
  const dismissed = { ...readDismissed(), [k]: new Date().toISOString() };
  const keep = Object.entries(dismissed).sort((a, b) => ms(b[1]) - ms(a[1])).slice(0, 200);
  try {
    mkdirSync(dataRoot, { recursive: true });
    const tmp = `${SUGGEST_FILE()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ dismissed: Object.fromEntries(keep) }, null, 2));
    renameSync(tmp, SUGGEST_FILE());
  } catch (e) {
    return fail("conflict", `忽略没存上：${String(e).slice(0, 120)}`);
  }
  return { ok: true, msg: "已忽略" };
}

/** sources：每次任务/会话实际动过的目录组（主目录 + 附加目录）。只算同 scope 的组合——
 *  跨 work/private 的组合本来就建不成角色，提了也只能拒，不如不提 */
export function crossRoleSuggestions(sources: Array<{ dirs: string[]; at: string }>, limit = 5): RoleSuggestion[] {
  const dismissed = readDismissed();
  const roles = listRoles();
  const byKey = new Map<string, RoleSuggestion & { ids: ProjectIdentity[] }>();
  for (const src of sources) {
    if (!src?.dirs || src.dirs.length < 2) continue;
    const ids = uniq(src.dirs.map((d) => projectOf(d)).filter((x): x is ProjectIdentity => !!x));
    for (const scope of new Set(ids.map((x) => x.scope))) {
      const group = ids.filter((x) => x.scope === scope).sort((a, b) => (a.slug < b.slug ? -1 : 1));
      if (group.length < 2) continue;
      const key = `${scope}|${group.map((x) => x.slug).join("+")}`;
      const cur = byKey.get(key);
      if (cur) { cur.count++; if (ms(src.at) > ms(cur.lastAt)) cur.lastAt = src.at; continue; }
      const labels = group.map((x) => x.label);
      byKey.set(key, {
        key, scope, slugs: group.map((x) => x.slug), labels, dirs: group.map((x) => x.root),
        count: 1, lastAt: src.at || "", name: defaultCrossName(labels), ids: group,
      });
    }
  }
  const out: RoleSuggestion[] = [];
  for (const { ids, ...s } of byKey.values()) {
    if (findCoveringRole(s.scope, ids, roles)) continue;
    const at = dismissed[s.key];
    if (at && ms(s.lastAt) <= ms(at)) continue;
    out.push(s);
  }
  return out.sort((a, b) => ms(b.lastAt) - ms(a.lastAt)).slice(0, limit);
}
