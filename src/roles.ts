// Role 层：角色是显性的持久化一等对象，落在 vault 的 <scope>/roles/<role-id>/。
// 目录即真相：role.json 只存结构化配置（人不用手改），principles/decisions/backlog/README
// 是人类可编辑的长期记忆（Obsidian 里直接改）。从角色进对话时按 global + role + projects
// 组装最小 Context Pack，不做向量检索、不做自动迁移。
//
// V2 起角色是两层研发组织：
//   type=lead    职能负责人，管跨项目的原则/决策，不绑主项目、不挂上级；
//   type=project 项目专家，一线开发入口，必须有主项目（且必在关联项目里），可选挂一个同 scope 的 lead。
// 旧 role.json 没有 type 字段 → 按 lead 读（V1 的角色就是职能视角，语义不变）。
// 项目知识不复制进角色：项目专家的 Context Pack 只是「强制注入主项目 README」，
// 项目自己的正式记忆与候选都归 project-memory.ts 管（<scope>/projects/<slug>/）。
//
// 三条硬约束（与 memory 层同源，别绕）：
//   1. scope 物理隔离——角色只读自己 scope 下的项目 README，绝不跨 work/private 取材；
//   2. 路径白名单——id / candidateId 先过严格正则，落盘前再复核 startsWith(rolesDir + "/")；
//   3. 候选人工晋升门——对话/LLM 只能写 _candidates/，正式 markdown 只有人点晋升才会被追加。
//
// 另两条同等重要（vault 是人和同步工具都能碰的目录，磁盘内容一律当外部输入）：
//   4. role.json 读进来要过和写入侧同一套 schema 校验——手改/同步冲突让 projects 混进 ../../
//      就能把项目 README 读越界；坏 manifest 整份作废，宁可角色暂时不可用也不半信半疑地用；
//   5. id 是跨 scope 的全局主键——同 id 出现两份是歧义，一律 conflict，绝不静默命中第一份
//      （另一份的记忆会凭空消失，是最难查的一类 bug）。
import { isStrictlyWithin } from "./path-within.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { ALL_SCOPES, projectDir, projectsDir, roleDir, rolesDir, VAULT_ROOT, type Scope } from "./paths.ts";
import { fmt, log } from "./util.ts";

// ---- 白名单与配额（API 入参一律先过这里，不接受任意路径/任意长度） ----
export const ROLE_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;      // 2–40 位，目录名直接用它
const CANDIDATE_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;              // 项目 slug（capture.ts 用目录名小写）
const HEX_RE = /^#[0-9a-f]{6}$/i;
/** icon 是预设枚举而不是自由字符串：前端拿它查图标表，杜绝 HTML/SVG 注入面 */
export const ROLE_ICONS = ["star", "code", "design", "product", "research", "ops", "write", "growth", "finance", "life"] as const;
export const PROMOTE_TARGETS = ["principles", "decisions", "backlog"] as const;
export type PromoteTarget = typeof PROMOTE_TARGETS[number];
/** 组织里的两种角色。顺序即前端展示顺序，别乱调 */
export const ROLE_TYPES = ["lead", "project"] as const;
export type RoleType = typeof ROLE_TYPES[number];

const MAX_NAME = 30, MAX_DESC = 200, MAX_INSTRUCTIONS = 2000, MAX_PROJECTS = 20;
const MAX_PARENT_DEPTH = 8;   // 父链走查上限：正常只有两层，纯粹是防人工改文件造出的环/长链
const MAX_CANDIDATE_TEXT = 1000, MAX_EVIDENCE = 2000, MAX_CANDIDATES = 200;
const CAP_PRINCIPLES = 4000, CAP_DECISIONS = 4000, CAP_BACKLOG = 2000, CAP_README = 3000;

// ---- 类型 ----
export interface RoleFields {
  name: string;
  description: string;
  icon: string;
  color: string;
  projects: string[];
  instructions: string;
  /** lead=职能负责人 / project=项目专家。旧 role.json 没这个键 → lead */
  type: RoleType;
  /** 仅项目专家可有：同 scope、active、type=lead 的角色 id（空=不挂靠） */
  parentRoleId: string;
  /** 仅项目专家必填：主项目 slug，必在 projects 里；对话强制注入它的 README */
  primaryProject: string;
}

/** 落盘的 role.json（不含 scope：目录位置就是 scope，两处记会不一致） */
export interface RoleManifest extends RoleFields {
  id: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

/** 对外的角色对象 = manifest + 派生的 scope（+ 冲突/组织标记，纯派生、绝不落盘） */
export interface Role extends RoleManifest {
  scope: Scope;
  /** 歧义标记，两种来源：① 同 id 跨 scope 有多份；② 同 scope 同主项目有多个在岗专家。
   *  列表里全都留着（藏掉一份等于让那份记忆凭空消失），但按 id 寻址的接口一律拒绝操作。 */
  conflict?: boolean;
  /** 冲突原因原话——两种冲突的修法不一样（改名 vs 归档/改主项目），前端别自己编 */
  conflictMsg?: string;
  /** 名下在岗（active）的项目专家数——只有 listRoles 会算，resolveRole 不做全量扫描 */
  childCount?: number;
  /** parentRoleId 指着的上级不可用（被删/归档/不是 lead/跨 scope/id 冲突）——如实标出来，不装作没挂 */
  parentMissing?: boolean;
}

/** 组织树上的一个节点（列表/详情共用的轻量引用，不含记忆内容） */
export interface RoleRef {
  id: string;
  name: string;
  icon: string;
  color: string;
  scope: Scope;
  type: RoleType;
  status: string;
  primaryProject: string;
}

export interface RoleCandidate {
  id: string;
  role: string;
  text: string;
  evidence: string;
  sourceChat: string;
  createdAt: string;
  status: string;
}

/** 失败一律带 code：API 层据此给 400/404/409，不许糊成 200 或裸 500 */
export type Fail = { ok: false; code: "invalid" | "not_found" | "conflict"; msg: string };
export type Result<T> = ({ ok: true } & T) | Fail;

const fail = (code: Fail["code"], msg: string): Fail => ({ ok: false, code, msg });
const isFail = (v: unknown): v is Fail => !!v && (v as any).ok === false;

// ---- 可注入 vault 根（只给单测用；生产恒为 paths.ts 的 VAULT_ROOT） ----
// 注入的是"根"而不是整套路径推导——测试与生产跑的是同一条 rolesDir/roleDir 代码路径，
// 不会出现"测试过了但真实目录布局不对"。
let vault: { root: string; scopes: Scope[] } = { root: VAULT_ROOT, scopes: ALL_SCOPES };

/** 单测注入临时 vault；传 null 恢复真实 vault。业务代码永远不要调用。 */
export function useVaultForTest(root: string | null, scopes: Scope[] = [""]) {
  vault = root ? { root, scopes: scopes.length ? scopes : [""] } : { root: VAULT_ROOT, scopes: ALL_SCOPES };
}

/** 当前生效的 vault（project-memory.ts 用）：两个模块必须看同一个根，
 *  否则单测注入临时 vault 时角色在 A、项目候选在 B，测试全绿但线上串目录。 */
export const activeVault = () => vault;

const defaultScope = (): Scope => vault.scopes[0] ?? "";
const scopeTag = (s: Scope) => (s ? `${s}/` : "");
const roleHome = (id: string, scope: Scope) => roleDir(id, scope, vault.root);
const len = (s: string) => [...s].length;   // 中文按字计数，不按 UTF-16 码元

/** 落盘前的第二道门：任何写入路径都必须在本 scope 的 roles/ 之内（第一道是 id 正则） */
function insideRoles(p: string, scope: Scope): boolean {
  return isStrictlyWithin(rolesDir(scope, vault.root), p);
}

function readCap(file: string, cap: number): string {
  try {
    const t = readFileSync(file, "utf8").trim();
    return t.length > cap ? t.slice(0, cap) + "\n…(截断)" : t;
  } catch { return ""; }
}

// ---- manifest 读写 ----
/** 时间戳归一成 ISO：列表排序按字符串比大小，手写的 "2026-01-01" 混进来会排错位 */
function normTime(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 40) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const STR_FIELDS = ["name", "description", "icon", "color", "instructions", "type", "parentRoleId", "primaryProject"] as const;

/** null = 这个目录里没有 role.json（不是角色目录，不算丢数据）
 *  Fail = 有但不可用（坏 JSON / 字段越界），调用方必须显式跳过或报错，不许当没看见
 *
 *  磁盘上的 role.json 一律当外部输入：Obsidian 同步冲突、人手编辑、别的机器写回来的版本
 *  都可能是任意内容。字段走 normalizeFields —— 与 create/update 完全同一套校验，
 *  磁盘上的角色不允许比 API 能创建的更宽松（projects 混进 ../../ 就是路径穿越）。 */
function loadManifest(dir: string, id: string): { ok: true; manifest: RoleManifest } | Fail | null {
  const f = join(dir, "role.json");
  if (!existsSync(f)) return null;

  let raw: any;
  try { raw = JSON.parse(readFileSync(f, "utf8")); }
  catch { return fail("invalid", "role.json 不是合法 JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid", "role.json 不是一个对象");

  // 类型先卡死再谈取值：String(对象) 会静默变成 "[object Object]" 这种假数据
  for (const k of STR_FIELDS) {
    if (raw[k] !== undefined && typeof raw[k] !== "string") return fail("invalid", `role.json 的 ${k} 必须是字符串`);
  }
  if (raw.projects !== undefined && (!Array.isArray(raw.projects) || raw.projects.some((x: unknown) => typeof x !== "string"))) {
    return fail("invalid", "role.json 的 projects 必须是字符串数组");
  }

  const f2 = normalizeFields(raw, DEFAULTS);   // 缺的键取默认值，给了就必须合法
  if (isFail(f2)) return fail("invalid", `role.json 字段不合法（${f2.msg}）`);
  if (!f2.name) return fail("invalid", "role.json 缺少角色名称");
  // 组织字段的自洽性也在这道门里（不读别的角色，所以不会递归）：手改成"项目专家但没有主项目"
  // 或"主项目不在关联项目里"的 manifest 整份作废——半份组织关系比没有更难查。
  const shape = checkShape(f2, id);
  if (shape) return fail("invalid", `role.json 组织字段不合法（${shape.msg}）`);
  if (raw.status !== "active" && raw.status !== "archived") {
    return fail("invalid", "role.json 的 status 只能是 active / archived");
  }
  const createdAt = normTime(raw.createdAt), updatedAt = normTime(raw.updatedAt);
  if (!createdAt || !updatedAt) return fail("invalid", "role.json 的 createdAt / updatedAt 不是合法时间");

  // id 以目录为准：手改过的 role.json 不能带偏路径（manifest 里的 id 直接忽略）
  return { ok: true, manifest: { id, ...(f2 as RoleFields), status: raw.status, createdAt, updatedAt } };
}

/** 临时文件 + rename：半写入的 role.json 会让角色在下次列表里凭空消失 */
function writeManifest(dir: string, m: RoleManifest) {
  const f = join(dir, "role.json");
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2) + "\n");
  renameSync(tmp, f);
}

const fieldsOf = (m: RoleManifest): RoleFields => ({
  name: m.name, description: m.description, icon: m.icon,
  color: m.color, projects: [...(m.projects || [])], instructions: m.instructions,
  type: m.type || "lead", parentRoleId: m.parentRoleId || "", primaryProject: m.primaryProject || "",
});

const DEFAULTS: RoleFields = {
  name: "", description: "", icon: "star", color: "#5b8def", projects: [], instructions: "",
  type: "lead", parentRoleId: "", primaryProject: "",   // 旧 role.json 缺这三个键 → 就是 V1 的职能负责人
};

/** 只处理 input 里显式给出的键（update 的 patch 语义）；一处校验，create/update 共用 */
function normalizeFields(input: any, base: RoleFields): RoleFields | Fail {
  const out: RoleFields = { ...base, projects: [...base.projects] };

  if (input?.name !== undefined) {
    const name = String(input.name ?? "").trim().replace(/\s+/g, " ");
    if (len(name) < 1 || len(name) > MAX_NAME) return fail("invalid", `名称要 1–${MAX_NAME} 字`);
    out.name = name;
  }
  if (input?.description !== undefined) {
    const desc = String(input.description ?? "").trim();
    if (len(desc) > MAX_DESC) return fail("invalid", `描述最多 ${MAX_DESC} 字`);
    out.description = desc;
  }
  if (input?.icon !== undefined) {
    const icon = String(input.icon ?? "").trim();
    if (!(ROLE_ICONS as readonly string[]).includes(icon)) return fail("invalid", `icon 只能是预设值：${ROLE_ICONS.join("/")}`);
    out.icon = icon;
  }
  if (input?.color !== undefined) {
    const color = String(input.color ?? "").trim();
    if (!HEX_RE.test(color)) return fail("invalid", "颜色必须是 #RRGGBB");
    out.color = color.toLowerCase();
  }
  if (input?.instructions !== undefined) {
    const ins = String(input.instructions ?? "").trim();
    if (len(ins) > MAX_INSTRUCTIONS) return fail("invalid", `职责说明最多 ${MAX_INSTRUCTIONS} 字`);
    out.instructions = ins;
  }
  if (input?.projects !== undefined) {
    if (!Array.isArray(input.projects)) return fail("invalid", "projects 必须是数组");
    const seen = new Set<string>();
    for (const raw of input.projects) {
      const slug = String(raw ?? "").trim().toLowerCase();
      if (!SLUG_RE.test(slug)) return fail("invalid", `项目 slug 不合法：${String(raw).slice(0, 40)}`);
      seen.add(slug);   // 多对多关系去重
    }
    if (seen.size > MAX_PROJECTS) return fail("invalid", `最多关联 ${MAX_PROJECTS} 个项目`);
    out.projects = [...seen];
  }
  if (input?.type !== undefined) {
    const t = String(input.type ?? "").trim();
    if (!(ROLE_TYPES as readonly string[]).includes(t)) return fail("invalid", `角色类型只能是 ${ROLE_TYPES.join(" / ")}`);
    out.type = t as RoleType;
  }
  if (input?.parentRoleId !== undefined) {
    // 空串是合法值（=不挂靠）；非空就必须过和角色 id 完全同一套白名单，它要拼目录去读上级
    const pid = String(input.parentRoleId ?? "").trim();
    if (pid && !ROLE_ID_RE.test(pid)) return fail("invalid", `上级角色 id 不合法：${pid.slice(0, 40)}`);
    out.parentRoleId = pid;
  }
  if (input?.primaryProject !== undefined) {
    const slug = String(input.primaryProject ?? "").trim().toLowerCase();
    if (slug && !SLUG_RE.test(slug)) return fail("invalid", `主项目 slug 不合法：${String(input.primaryProject).slice(0, 40)}`);
    out.primaryProject = slug;
  }
  return out;
}

/** 单份 manifest 内部的结构自洽：只看自己，不读别的角色（loadManifest 也走这条，
 *  递归读角色会在 id 冲突/坏文件上把自己绕死）。磁盘不许比 API 能创建的更宽松。 */
function checkShape(f: RoleFields, id: string): Fail | null {
  if (f.type === "lead") {
    if (f.parentRoleId) return fail("invalid", "职能负责人不能有上级（上级只属于项目专家）——改成职能负责人时请把 parentRoleId 一并清空");
    if (f.primaryProject) return fail("invalid", "职能负责人不能有主项目——改成职能负责人时请把 primaryProject 一并清空");
    return null;
  }
  if (!f.primaryProject) return fail("invalid", "项目专家必须指定主项目");
  if (!f.projects.includes(f.primaryProject)) return fail("invalid", `主项目 ${f.primaryProject} 必须在关联项目里`);
  if (f.parentRoleId && f.parentRoleId === id) return fail("invalid", "上级不能是自己");
  return null;
}

/** API 写入侧的便利：主项目自动并进关联项目。
 *  磁盘侧（loadManifest）故意不做这个兜底——手改出来的不一致要报错，不要被悄悄"修好"。 */
function withPrimary(f: RoleFields): RoleFields | Fail {
  if (f.type !== "project" || !f.primaryProject || f.projects.includes(f.primaryProject)) return f;
  if (f.projects.length >= MAX_PROJECTS) return fail("invalid", `最多关联 ${MAX_PROJECTS} 个项目（主项目也占一个名额）`);
  return { ...f, projects: [f.primaryProject, ...f.projects] };
}

/** 跨角色的组织约束：上级存在且合法、父链无环、同 scope 同主项目只留一个在岗专家、
 *  项目专家不能当上级。只在写入路径（create/update/archive）跑——读路径跑会递归。 */
function checkLinks(f: RoleFields, id: string, scope: Scope, status: "active" | "archived"): Fail | null {
  if (f.parentRoleId) {
    if (f.parentRoleId === id) return fail("invalid", "上级不能是自己");
    const p = resolveRole(f.parentRoleId);
    // 上级 id 冲突 → conflict 原样透传：修法是改名，不是"换一个上级"
    if (isFail(p)) return fail(p.code === "conflict" ? "conflict" : "invalid", `上级角色不可用：${p.msg}`);
    const parent = p.role;
    if (parent.scope !== scope) {
      return fail("invalid", `上级 ${parent.id} 属于 ${parent.scope || "根"}，本角色属于 ${scope || "根"}——跨 scope 不能挂靠（记忆会串味）`);
    }
    if (parent.type !== "lead") return fail("invalid", `上级必须是职能负责人，${parent.id} 是项目专家`);
    // "上级必须在岗"只对在岗角色成立：一对一起归档的上下级，改个描述不该被这条卡住
    // （恢复走的是 status="active" 这条路，照样拦得住"挂着归档上级复活"）
    if (parent.status !== "active" && status === "active") {
      return fail("invalid", `上级 ${parent.id} 已归档，先恢复它或改挂别人`);
    }

    // 正常只有两层，成环只可能来自人工改文件；真出现要拦在写入前，不然列表/树会转不完
    const seen = new Set<string>([id]);
    let cursor = parent.id;
    for (let i = 0; i < MAX_PARENT_DEPTH && cursor; i++) {
      if (seen.has(cursor)) return fail("conflict", `父子关系成环（${cursor}），先在 vault 里理顺再改`);
      seen.add(cursor);
      const up = resolveRole(cursor);
      if (isFail(up)) break;    // 上游坏了：上面那几条已经报过原因，这里不重复判
      cursor = up.role.parentRoleId;
    }
  }
  if (f.type === "project") {
    // listRoles() 默认只给 active——归档的专家不占主项目名额，也不算"名下还有人"
    const peers = listRoles();
    if (status === "active") {
      const dup = peers.find((r) => r.id !== id && r.scope === scope && r.type === "project" && r.primaryProject === f.primaryProject);
      if (dup) return fail("conflict", `项目 ${f.primaryProject} 已经有专家「${dup.name}」（${dup.id}），一个项目同时只留一个在岗专家`);
    }
    const kids = peers.filter((r) => r.id !== id && r.scope === scope && r.parentRoleId === id);
    if (kids.length) {
      return fail("conflict", `${id} 名下还有 ${kids.length} 个在岗专家（${kids.map((k) => k.id).join("、")}），项目专家不能当上级——先把它们改挂到职能负责人`);
    }
  }
  return null;
}

function pickScope(v: unknown): Scope | null {
  if (v === undefined || v === null || v === "") return defaultScope();
  return vault.scopes.includes(v as Scope) ? v as Scope : null;
}

// ---- 查询 ----
/** Map 的复合键：JSON 数组字符串，肉眼可读、无歧义。别用不可见分隔符——源码里看不出来，
 *  还会把整个文件变成二进制（file 报 data、git diff 直接不给看）。 */
const orgKey = (scope: Scope, id: string) => JSON.stringify([scope, id]);

/** 扫一个 scope 下所有可读的角色（坏 manifest 跳过并留痕）。
 *  listRoles 与主项目冲突判定共用这一条扫描——两处各写一遍必然会漂。
 *  注意：这里绝不能调 resolveRole（它反过来要用本函数判冲突，会无限递归）。 */
function scanScope(scope: Scope): Role[] {
  const out: Role[] = [];
  const dir = rolesDir(scope, vault.root);
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!ROLE_ID_RE.test(name)) continue;
    const r = loadManifest(join(dir, name), name);
    if (!r) continue;                                     // 不是角色目录，不算丢数据
    if (isFail(r)) { log(`roles: 跳过 ${scopeTag(scope)}${name}——${r.msg}（人工修一下）`); continue; }
    out.push({ ...r.manifest, scope });
  }
  return out;
}

/** 同 scope 同主项目的其它在岗专家。
 *  写入侧（checkLinks）本来就拦得住，但磁盘是人和同步工具都能碰的：手工建目录、vault 同步冲突
 *  都能落下两份各自合法的 role.json。那时「这个项目的专家是谁」就是歧义——注入哪一份都可能
 *  长在错的记忆上，跟跨 scope 同 id 是同一类问题，所以读取侧也必须判、也一律拒绝操作。 */
function primaryRivals(role: Role): Role[] {
  if (role.type !== "project" || !role.primaryProject || role.status !== "active") return [];
  return scanScope(role.scope).filter((r) =>
    r.id !== role.id && r.status === "active" && r.type === "project" && r.primaryProject === role.primaryProject);
}

const rivalMsg = (role: Role, rivals: Role[]) =>
  `项目 ${role.primaryProject} 在 ${role.scope || "(根)"} 下有 ${rivals.length + 1} 个在岗专家（${[role, ...rivals].map((r) => r.id).join("、")}）`
  + "——说不清该用哪一份记忆，先归档其中一个或改掉它的主项目";

export function listRoles(opts: { includeArchived?: boolean } = {}): Role[] {
  const all: Role[] = [];
  for (const scope of vault.scopes) all.push(...scanScope(scope));

  // 跨 scope 同 id：两份都留在列表里但显式标 conflict——藏掉一份等于让那份角色的记忆凭空消失，
  // 按 id 寻址的接口则一律 409（见 resolveRole）。归档的也参与判定，否则列表与接口会对不上。
  const seen = new Map<string, number>();
  for (const r of all) seen.set(r.id, (seen.get(r.id) || 0) + 1);
  for (const [id, n] of seen) {
    if (n > 1) log(`roles: id ${id} 跨 scope 有 ${n} 份，已标 conflict——按 id 的接口一概拒绝操作（人工改名一个）`);
  }

  // 同 scope 同主项目多个在岗专家：同样两份都留、两份都标 conflict（列表与接口不能对不上）
  const rivals = new Map<string, Role[]>();
  for (const r of all) {
    if (r.status !== "active" || r.type !== "project" || !r.primaryProject) continue;
    const key = orgKey(r.scope, r.primaryProject);
    rivals.set(key, [...(rivals.get(key) || []), r]);
  }
  for (const [key, rs] of rivals) {
    if (rs.length > 1) log(`roles: ${key} 有 ${rs.length} 个在岗专家（${rs.map((r) => r.id).join("、")}），已标 conflict——按 id 的接口一概拒绝操作`);
  }
  const rivalOf = (r: Role) =>
    (r.status === "active" && r.type === "project" && r.primaryProject
      ? rivals.get(orgKey(r.scope, r.primaryProject)) || [] : []).filter((x) => x.id !== r.id);

  // 组织关系是派生信息：子专家数按「在岗 + 同 scope」算，上级不可用如实标 parentMissing。
  // 归档筛选之前算——否则关掉"含归档"时子数会莫名变化，用户以为专家丢了。
  const kids = new Map<string, number>();
  for (const r of all) {
    if (r.status !== "active" || !r.parentRoleId) continue;
    const key = orgKey(r.scope, r.parentRoleId);
    kids.set(key, (kids.get(key) || 0) + 1);
  }
  const byId = new Map<string, Role[]>();
  for (const r of all) byId.set(r.id, [...(byId.get(r.id) || []), r]);
  const parentOk = (r: Role) => {
    const hits = byId.get(r.parentRoleId) || [];
    // 同 id 有多份 = 按 id 寻址是歧义（resolveRole 也会拒），对挂靠来说等同于上级不可用
    return hits.length === 1 && hits[0].scope === r.scope && hits[0].type === "lead" && hits[0].status === "active";
  };

  return all
    .filter((r) => opts.includeArchived || r.status !== "archived")
    .map((r) => {
      const dupId = seen.get(r.id)! > 1;
      const rival = rivalOf(r);
      // 两类冲突共用 conflict 标（前端一律不许拿它开对话），原因写进 conflictMsg——
      // 修法不一样：id 冲突要改名，主项目冲突要归档/改主项目
      return {
        ...r,
        ...(dupId
          ? { conflict: true, conflictMsg: `角色 id ${r.id} 跨 scope 有 ${seen.get(r.id)} 份，按 id 寻址是歧义——先在 vault 里改名一个` }
          : rival.length ? { conflict: true, conflictMsg: rivalMsg(r, rival) } : {}),
        childCount: kids.get(orgKey(r.scope, r.id)) || 0,
        ...(r.parentRoleId && !parentOk(r) ? { parentMissing: true } : {}),
      };
    })
    .sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1);
}

const refOf = (r: Role): RoleRef => ({
  id: r.id, name: r.name, icon: r.icon, color: r.color,
  scope: r.scope, type: r.type, status: r.status, primaryProject: r.primaryProject,
});

/** 一个角色的组织上下文（详情页用）：上级 + 下属专家（含归档，前端自己分组显示）。
 *  上级不可用时 parent=null + parentMissing=true + 原因——不装作它没挂过上级。 */
export function roleOrg(role: Role): { parent: RoleRef | null; parentMissing: boolean; parentMsg: string; children: RoleRef[] } {
  const children = listRoles({ includeArchived: true })
    .filter((r) => r.scope === role.scope && r.parentRoleId === role.id && r.id !== role.id)
    .map(refOf);
  if (!role.parentRoleId) return { parent: null, parentMissing: false, parentMsg: "", children };

  const p = resolveRole(role.parentRoleId);
  if (isFail(p)) return { parent: null, parentMissing: true, parentMsg: p.msg, children };
  if (p.role.scope !== role.scope) {
    return { parent: null, parentMissing: true, parentMsg: `上级 ${p.role.id} 不在同一个 scope`, children };
  }
  if (p.role.type !== "lead") return { parent: refOf(p.role), parentMissing: true, parentMsg: `上级 ${p.role.id} 已不是职能负责人`, children };
  if (p.role.status !== "active") return { parent: refOf(p.role), parentMissing: true, parentMsg: `上级 ${p.role.id} 已归档`, children };
  return { parent: refOf(p.role), parentMissing: false, parentMsg: "", children };
}

/** 按 id 定位唯一一个角色。三种失败都必须让调用方看见，不许糊成"没找到"：
 *    not_found —— id 不合法或真没有；
 *    invalid   —— 目录在、role.json 坏（人工修，不是自动重建）；
 *    conflict  —— ① 同 id 跨 scope 有多份，命中谁都是错的；
 *                 ② 同 scope 同主项目有多个在岗专家（磁盘旁路落进来的），用哪一份记忆是歧义。
 *  两类冲突都收在这一个入口：update / archive / 候选 / roleMemoryPack / 对话绑定全走 resolveRole，
 *  堵在这里就没有"某条路径漏判"的可能。
 *  坏 manifest 不参与冲突判定：一个手滑写坏的 private/roles/dev 不该把 work/roles/dev 也拖下水。 */
export function resolveRole(id: string): Result<{ role: Role }> {
  const r = locateRole(id);
  if (isFail(r)) return r;
  // 主项目冲突只可能出现在「在岗项目专家」上：职能负责人（绝大多数调用）连扫描都不做
  const rivals = primaryRivals(r.role);
  if (rivals.length) return fail("conflict", rivalMsg(r.role, rivals));
  return r;
}

/** 只解决「哪一份文件」，不判主项目冲突。
 *  给 update / archive 这类**修复动作**用：主项目冲突的修法就是归档一份或改它的主项目，
 *  修复入口自己走 resolveRole 会把出路堵死（而这两个动作要写的文件是唯一的，不存在歧义）。
 *  能不能真的落盘仍由 checkLinks 说了算——只允许把局面改好，不允许维持冲突。 */
function locateRole(id: string): Result<{ role: Role }> {
  const rid = String(id ?? "");
  if (!ROLE_ID_RE.test(rid)) return fail("not_found", `角色不存在：${rid.slice(0, 40)}`);

  const found: Role[] = [];
  const broken: string[] = [];
  for (const scope of vault.scopes) {
    const r = loadManifest(roleHome(rid, scope), rid);
    if (!r) continue;
    if (isFail(r)) { broken.push(`${scopeTag(scope)}${rid}：${r.msg}`); continue; }
    found.push({ ...r.manifest, scope });
  }

  if (found.length > 1) {
    const where = found.map((r) => `${r.scope || "(根)"}/`).join(" 和 ");
    return fail("conflict", `角色 id ${rid} 在 ${where} 各有一份，按 id 寻址是歧义——先在 vault 里改名其中一个`);
  }
  if (broken.length) log(`roles: ${broken.join("；")}`);
  if (found.length === 1) return { ok: true, role: found[0] };
  if (broken.length) return fail("invalid", `角色 ${rid} 的 role.json 不可用，先人工修：${broken.join("；")}`);
  return fail("not_found", `角色不存在：${rid.slice(0, 40)}`);
}

/** 存在性判断用的薄封装：拿不到"唯一一份"就是 null（含 id 冲突、role.json 坏）。
 *  要给用户看原因（404 / 409 / 400 分开）就用 resolveRole——null 说不清是哪种。 */
export function getRole(id: string): Role | null {
  const r = resolveRole(id);
  return isFail(r) ? null : r.role;
}

/** 可关联的项目 slug：只列本 scope 的（work 角色看不到 private 项目名） */
export function listProjectSlugs(scope: Scope = defaultScope()): string[] {
  const dir = projectsDir(scope, vault.root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && SLUG_RE.test(d.name))
    .map((d) => d.name)
    .sort();
}

// ---- 增改 ----
export function createRole(input: any): Result<{ role: Role }> {
  // 不做大小写归一：id 就是目录名，静默改写会让"我建的是 Dev，怎么成了 dev"变成谜题
  const id = String(input?.id ?? "").trim();
  if (!ROLE_ID_RE.test(id)) return fail("invalid", "角色 id 只能是小写字母/数字/连字符，2–40 位，且以字母数字开头");
  const scope = pickScope(input?.scope);
  if (scope === null) return fail("invalid", `scope 只能是 ${vault.scopes.map((s) => s || "(不分流)").join(" / ")}`);
  if (input?.name === undefined) return fail("invalid", "缺少角色名称");

  const f0 = normalizeFields(input, DEFAULTS);
  if (isFail(f0)) return f0;
  const f = withPrimary(f0);
  if (isFail(f)) return f;
  const shape = checkShape(f, id);
  if (shape) return shape;
  // id 是跨 scope 的全局主键：API 只按 id 寻址，同名不同 scope 会互相顶掉。
  // 已冲突 / role.json 坏掉时也不许新建：那等于往一个已经说不清的 id 上再叠一层。
  // 用 locateRole：这里只关心"这个 id 占没占"，占了就是 409，跟它有没有主项目冲突无关。
  const exist = locateRole(id);
  if (!isFail(exist)) return fail("conflict", `角色 ${id} 已存在`);
  if (exist.code !== "not_found") return exist;
  const links = checkLinks(f, id, scope, "active");
  if (links) return links;

  const dir = roleHome(id, scope);
  if (!insideRoles(dir, scope)) return fail("invalid", "角色路径越界");

  const now = new Date().toISOString();
  const manifest: RoleManifest = { id, ...f, status: "active", createdAt: now, updatedAt: now };
  mkdirSync(join(dir, "_candidates"), { recursive: true });
  writeManifest(dir, manifest);
  seedDocs(dir, manifest, scope);
  log(`roles: created ${scopeTag(scope)}${id}（${manifest.name}·${manifest.type === "project" ? `项目专家/${manifest.primaryProject}` : "职能负责人"}）`);
  return { ok: true, role: { ...manifest, scope } };
}

export function updateRole(id: string, patch: any): Result<{ role: Role }> {
  // locateRole：主项目冲突时也要能改（改主项目/改类型就是修法）；维持冲突的改动由 checkLinks 拦
  const r = locateRole(id);
  if (isFail(r)) return r;
  const cur = r.role;
  if (patch?.id !== undefined && String(patch.id) !== cur.id) return fail("invalid", "角色 id 不可修改");
  if (patch?.scope !== undefined && String(patch.scope) !== cur.scope) {
    return fail("invalid", "角色 scope 不可修改（跨 scope 迁移要人工搬目录，避免记忆串味）");
  }
  if (patch?.status !== undefined && patch.status !== cur.status) {
    return fail("invalid", "状态请走归档接口（/archive）");
  }

  const f0 = normalizeFields(patch, fieldsOf(cur));
  if (isFail(f0)) return f0;
  const f = withPrimary(f0);
  if (isFail(f)) return f;
  const shape = checkShape(f, cur.id);
  if (shape) return shape;
  // 归档角色照样要过组织约束（除了"主项目占位"那条——归档的不占名额，见 checkLinks）
  const links = checkLinks(f, cur.id, cur.scope, cur.status as "active" | "archived");
  if (links) return links;
  const manifest: RoleManifest = {
    id: cur.id, ...f, status: cur.status,
    createdAt: cur.createdAt, updatedAt: new Date().toISOString(),
  };
  const dir = roleHome(cur.id, cur.scope);
  if (!insideRoles(dir, cur.scope)) return fail("invalid", "角色路径越界");
  writeManifest(dir, manifest);
  return { ok: true, role: { ...manifest, scope: cur.scope } };
}

/** 只归档/恢复，永不删除：历史对话还引着这个角色，文件也是人的资产。
 *  组织约束在这里也要守：归档还有在岗专家的 lead 会把它们变成"挂着空上级"，一律 conflict；
 *  恢复则要重跑一遍挂靠/主项目占位校验（归档期间上级可能已经没了、主项目可能被别人接手）。 */
export function archiveRole(id: string, archived: boolean): Result<{ role: Role }> {
  // locateRole：归档正是主项目冲突的解法，用 resolveRole 会把唯一的出路也堵上
  const r = locateRole(id);
  if (isFail(r)) return r;
  const cur = r.role;
  if (archived && cur.type === "lead") {
    const kids = listRoles().filter((x) => x.scope === cur.scope && x.parentRoleId === cur.id);
    if (kids.length) {
      return fail("conflict", `「${cur.name}」名下还有 ${kids.length} 个在岗项目专家（${kids.map((k) => k.id).join("、")}）——先把它们改挂到别的负责人或一并归档`);
    }
  }
  if (!archived) {
    const links = checkLinks(fieldsOf(cur), cur.id, cur.scope, "active");
    if (links) return links;
  }
  const manifest: RoleManifest = {
    ...fieldsOf(cur), id: cur.id,
    status: archived ? "archived" : "active",
    createdAt: cur.createdAt, updatedAt: new Date().toISOString(),
  };
  writeManifest(roleHome(cur.id, cur.scope), manifest);
  log(`roles: ${archived ? "archived" : "restored"} ${scopeTag(cur.scope)}${cur.id}`);
  return { ok: true, role: { ...manifest, scope: cur.scope } };
}

// ---- Context Pack ----
export interface PackOptions {
  /** 强制注入的项目（取消不掉的那个）。三种取值语义不同，别混：
   *    undefined —— 按角色**当前**主项目（角色页预览这类"看现在"的场景）；
   *    ""        —— 明确不强制（V1 时代建的对话：项目范围就是它当时选的那些，不许追加）；
   *    "<slug>"  —— 强制这一个（对话绑定快照：角色后来换了主项目也不改历史）。
   *  快照项目即便已从角色关联里去掉也照注：它是这个对话成立的前提，不是"现在还关不关联"的问题。
   *  但路径安全照走（slug 白名单 + 同 scope 前缀复核）——快照来自磁盘，一样当外部输入。 */
  forcedProject?: string;
}

/** 角色记忆包：角色定义 + 三份 markdown + 「已关联且本次选择」的项目 README（同 scope）。
 *  项目专家额外强制注入主项目 README——本轮选择只能缩小附加项目，取消不掉主项目
 *  （前端锁死是体验，这里锁死才是保证：手改 chat JSON 也绕不过去）。
 *  角色不存在直接抛——静默返回空串等于假装注入成功，是最难查的一类 bug。 */
export function roleMemoryPack(id: string, selectedProjects?: string[], opts?: PackOptions): string {
  const r = resolveRole(id);
  if (isFail(r)) throw new Error(r.msg);   // 不存在 / role.json 坏 / id 冲突，都别拿去注入
  const role = r.role;
  const dir = roleHome(role.id, role.scope);

  // 强制项目：缺省跟角色当前主项目走；对话侧会显式传快照（或传 "" 表示这段历史不带主项目）
  const forced = opts?.forcedProject === undefined
    ? (role.type === "project" ? role.primaryProject : "")
    : String(opts.forcedProject || "").trim().toLowerCase();
  const isExpertNow = role.type === "project" && !!role.primaryProject;
  const head = [`### 角色：${role.name}（${role.id}） · ${isExpertNow ? "项目专家" : "职能负责人"}`];
  if (forced) {
    // 上级读不到就只写 id：注入不该因为组织关系有瑕疵而失败（真读不到的是记忆，不是这一行字）
    const p = role.parentRoleId ? resolveRole(role.parentRoleId) : null;
    const parent = p && !isFail(p) ? `${p.role.name}（${p.role.id}）` : role.parentRoleId;
    // 角色后来换了主项目：本对话仍按绑定时那个走，但把差异说清楚，免得模型拿现在的事实纠正自己
    const moved = isExpertNow && forced !== role.primaryProject ? `（本对话绑定时的主项目；角色现在的主项目是 ${role.primaryProject}）` : "（项目 README 是这个项目的唯一真相）";
    head.push(`主项目：${forced}${moved}${parent ? ` · 上级：${parent}` : ""}`);
  } else if (isExpertNow) {
    // 旧对话遇上"角色后来变成了项目专家"：项目范围冻结在创建时的选择，不追加主项目
    head.push(`（本对话建于该角色成为项目专家之前，项目范围沿用创建时的选择）`);
  }
  if (role.description) head.push(role.description);
  if (role.instructions) head.push("", "**职责边界**", role.instructions);
  const parts: string[] = [head.join("\n")];

  const add = (label: string, file: string, cap: number) => {
    const t = readCap(join(dir, file), cap);
    if (t) parts.push(`### ${label}\n${t}`);
  };
  add("原则", "principles.md", CAP_PRINCIPLES);
  add("决策", "decisions.md", CAP_DECISIONS);
  add("待办", "backlog.md", CAP_BACKLOG);

  // 选择集与关联集取交集：既不能注入没关联的项目，也不能无视本次的缩小范围
  const wanted = selectedProjects && new Set(selectedProjects.map((x) => String(x ?? "").trim().toLowerCase()));
  const chosen = wanted ? role.projects.filter((s) => wanted.has(s)) : role.projects;
  // 强制项目排在最前且不可去除。它可能已经不在 role.projects 里了（角色改了关联/换了主项目），
  // 照注不误——那是这个对话成立的前提；越界与否仍由下面的 slug 白名单 + 前缀复核说了算。
  const picked = forced ? [forced, ...chosen.filter((s) => s !== forced)] : chosen;
  // 只读角色自己 scope 下的 projects/：跨 scope 查找会让工作角色读到私人项目
  const base = projectsDir(role.scope, vault.root);
  for (const slug of picked.slice(0, MAX_PROJECTS)) {
    // manifest 读进来时已经校验过一遍；这里是第二道——slug 是拼路径的唯一变量，
    // 多查一次的成本是零，漏一次的代价是把 scope 外的文件注进对话
    if (!SLUG_RE.test(slug)) { log(`roles: 跳过不合法的项目 slug ${scopeTag(role.scope)}${role.id} → ${String(slug).slice(0, 40)}`); continue; }
    const readmeFile = join(projectDir(slug, role.scope, vault.root), "README.md");
    if (!isStrictlyWithin(base, readmeFile)) { log(`roles: 项目 README 越界，跳过 ${scopeTag(role.scope)}${role.id} → ${slug}`); continue; }
    const readme = readCap(readmeFile, CAP_README);
    if (readme) parts.push(`### ${forced && slug === forced ? "主项目记忆" : "项目记忆"}：${slug}\n${readme}`);
  }

  return `\n=== 角色记忆（vault ${scopeTag(role.scope)}roles/${role.id}/，可能过时，与事实冲突以事实为准）===\n${parts.join("\n\n")}\n`;
}

// ---- 候选记忆（人工晋升门） ----
function candidatesDir(role: Role): string {
  return join(roleHome(role.id, role.scope), "_candidates");
}

function candidateFile(role: Role, cid: string): string | null {
  if (!CANDIDATE_ID_RE.test(cid)) return null;                      // 第一道：白名单
  const f = join(candidatesDir(role), `${cid}.md`);
  if (!insideRoles(f, role.scope)) return null;                     // 第二道：越界复核
  return f;
}

export function createRoleCandidate(
  id: string,
  input: { text?: string; evidence?: string; sourceChatId?: string },
): Result<{ candidate: RoleCandidate }> {
  const r0 = resolveRole(id);
  if (isFail(r0)) return r0;
  const role = r0.role;
  const text = String(input?.text ?? "").trim();
  if (!text) return fail("invalid", "候选内容为空");
  if (len(text) > MAX_CANDIDATE_TEXT) return fail("invalid", `候选内容最多 ${MAX_CANDIDATE_TEXT} 字`);
  const evidence = String(input?.evidence ?? "").trim().slice(0, MAX_EVIDENCE);
  const sourceChat = String(input?.sourceChatId ?? "").trim().slice(0, 64).replace(/[^\w.:-]/g, "") || "-";

  const dir = candidatesDir(role);
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).filter((f) => f.endsWith(".md")).length >= MAX_CANDIDATES) {
    return fail("conflict", `候选记忆已达上限 ${MAX_CANDIDATES} 条，先晋升或丢弃一些`);
  }

  const createdAt = new Date().toISOString();
  const day = fmt(new Date(), "date").replaceAll("-", "");
  let cid = "", file = "";
  for (let i = 0; i < 20 && !file; i++) {
    cid = `${day}-${Math.random().toString(36).slice(2, 8)}`;
    const f = candidateFile(role, cid);
    if (f && !existsSync(f)) file = f;
  }
  if (!file) return fail("conflict", "候选 id 生成失败，请重试");

  writeFileSync(file, [
    "---",
    `role: ${role.id}`,
    `source_chat: ${sourceChat}`,
    `created_at: ${createdAt}`,
    "status: pending",
    "---",
    "",
    text,
    "",
    ...(evidence ? [`> 证据：${evidence}`, ""] : []),
  ].join("\n"));
  log(`roles: candidate ${scopeTag(role.scope)}${role.id}/${cid}（待人工晋升）`);
  return { ok: true, candidate: { id: cid, role: role.id, text, evidence, sourceChat, createdAt, status: "pending" } };
}

function parseCandidate(cid: string, roleId: string, raw: string): RoleCandidate {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const fm = new Map<string, string>();
  for (const line of (m?.[1] || "").split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) fm.set(kv[1], kv[2].trim());
  }
  const body = raw.slice(m?.[0].length || 0).trim();
  const ev = body.match(/^>\s*证据：([\s\S]*)$/m);
  return {
    id: cid,
    role: fm.get("role") || roleId,
    text: (ev ? body.slice(0, ev.index).trim() : body).slice(0, MAX_CANDIDATE_TEXT * 2),
    evidence: (ev?.[1] || "").trim().slice(0, MAX_EVIDENCE),
    sourceChat: fm.get("source_chat") || "-",
    createdAt: fm.get("created_at") || "",
    status: fm.get("status") || "pending",
  };
}

export function listRoleCandidates(id: string): Result<{ candidates: RoleCandidate[] }> {
  const r0 = resolveRole(id);
  if (isFail(r0)) return r0;
  const role = r0.role;
  const dir = candidatesDir(role);
  if (!existsSync(dir)) return { ok: true, candidates: [] };
  const out: RoleCandidate[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const cid = f.slice(0, -3);
    if (!CANDIDATE_ID_RE.test(cid)) { log(`roles: 跳过异常候选文件 ${role.id}/${f}`); continue; }
    try { out.push(parseCandidate(cid, role.id, readFileSync(join(dir, f), "utf8"))); }
    catch (e) { log(`roles: 候选读取失败 ${role.id}/${f}: ${e}`); }
  }
  return { ok: true, candidates: out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) };
}

/** 人工晋升：候选内容追加进正式 markdown，然后删掉候选文件。
 *  这是三道人工审批门之一——不许被 LLM/自动流程调用。 */
export function promoteRoleCandidate(
  id: string, candidateId: string, target: string,
): Result<{ target: string; msg: string }> {
  const r0 = resolveRole(id);
  if (isFail(r0)) return r0;
  const role = r0.role;
  if (!(PROMOTE_TARGETS as readonly string[]).includes(target)) {
    return fail("invalid", `晋升目标只能是 ${PROMOTE_TARGETS.join("/")}`);
  }
  const src = candidateFile(role, String(candidateId || ""));
  if (!src) return fail("invalid", "候选 id 不合法");
  if (!existsSync(src)) return fail("not_found", "候选不存在（可能已被晋升或丢弃）");

  const cand = parseCandidate(String(candidateId), role.id, readFileSync(src, "utf8"));
  const dest = join(roleHome(role.id, role.scope), `${target}.md`);
  if (!insideRoles(dest, role.scope)) return fail("invalid", "目标路径越界");

  const date = fmt(new Date(), "date");
  const entry = [
    `- ${cand.text.replace(/\n+/g, " ").trim()}`,
    `  - 来源：对话 ${cand.sourceChat} · 晋升于 ${date}`,
    ...(cand.evidence ? [`  - 证据：「${cand.evidence.replace(/\n+/g, " ").trim()}」`] : []),
    "",
  ].join("\n");
  // 正常情况种子文件一直在；这里的兜底是给"人手删了文件又来晋升"留的
  const title = { principles: "原则", decisions: "决策", backlog: "待办" }[target as PromoteTarget];
  const body = existsSync(dest) ? readFileSync(dest, "utf8").replace(/\s*$/, "\n") : `# ${title}\n`;
  // 临时文件 + rename（同 writeManifest）：整份重写崩在半路会把角色记忆截断成半份
  const tmp = `${dest}.tmp`;
  try {
    writeFileSync(tmp, `${body}\n${entry}`);
    renameSync(tmp, dest);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* 清不掉就留着，正式文件没被动过 */ }
    log(`roles: 晋升写入失败 ${role.id}/${target}.md: ${e}`);
    return fail("conflict", `写 ${target}.md 失败（候选还在，可重试）：${String(e).slice(0, 120)}`);
  }
  // 删候选失败不当成功报：不然下次晋升会把同一条再追加一遍
  try { rmSync(src); } catch (e) {
    log(`roles: 候选删除失败 ${role.id}/${candidateId}: ${e}`);
    return { ok: true, target, msg: `已晋升到 ${target}.md，但候选文件没删掉（${String(e).slice(0, 80)}）——请手动丢弃，否则会重复晋升` };
  }
  log(`roles: promoted ${scopeTag(role.scope)}${role.id}/${candidateId} → ${target}.md`);
  // 只回目标名，不回绝对路径：客户端拿不到 vault 的磁盘布局（要打开文件走 /api/vault/file）
  return { ok: true, target, msg: `已晋升到 ${target}.md` };
}

/** 丢弃候选：也是人工动作，删完就没了（正式记忆没被碰过） */
export function dismissRoleCandidate(id: string, candidateId: string): Result<{ msg: string }> {
  const r0 = resolveRole(id);
  if (isFail(r0)) return r0;
  const role = r0.role;
  const f = candidateFile(role, String(candidateId || ""));
  if (!f) return fail("invalid", "候选 id 不合法");
  if (!existsSync(f)) return fail("not_found", "候选不存在（可能已被晋升或丢弃）");
  rmSync(f);
  log(`roles: dismissed ${scopeTag(role.scope)}${role.id}/${candidateId}`);
  return { ok: true, msg: "已丢弃" };
}

// ---- 种子文件 ----
function seedDocs(dir: string, m: RoleManifest, scope: Scope) {
  const date = fmt(new Date(), "date");
  const seed = (file: string, lines: string[]) => {
    const f = join(dir, file);
    if (!existsSync(f)) writeFileSync(f, lines.join("\n"));
  };

  const expert = m.type === "project";
  seed("README.md", [
    "---", "type: role", `role: ${m.id}`, `role_type: ${m.type}`,
    ...(expert ? [`primary_project: ${m.primaryProject}`] : []),
    ...(m.parentRoleId ? [`parent_role: ${m.parentRoleId}`] : []),
    ...(scope ? [`scope: ${scope}`] : []), `updated_at: ${date}`, "---", "",
    `# ${m.name}`, "",
    `> ${expert ? `项目专家 · 主项目 ${m.primaryProject}` : "职能负责人（跨项目的原则与决策）"}`, "",
    m.description || "（写一句这个角色是干什么的）", "",
    "## 职责",
    m.instructions || "（负责什么、不负责什么）", "",
    "## 关联项目",
    ...(m.projects.length ? m.projects.map((p) => `- ${p}${p === m.primaryProject ? "（主项目）" : ""}`) : ["- （在角色页里关联）"]), "",
    "> 本文件是给人看的索引。注入对话的是 principles.md / decisions.md / backlog.md",
    `> 三份 + 本次选中的关联项目 README${expert ? "（主项目必注入）" : ""}——改行为改那三份。`,
    ...(expert ? ["> 项目本身的事实/决策/运维写在 projects/" + m.primaryProject + "/，不要复制进角色。"] : []), "",
  ]);

  seed("principles.md", [
    "---", "type: role_principles", `role: ${m.id}`, `updated_at: ${date}`, "---", "",
    "# 原则", "",
    "> 这个角色做判断时的稳定准则。一条一行，写结论不写过程。", "",
  ]);

  seed("decisions.md", [
    "---", "type: role_decisions", `role: ${m.id}`, `updated_at: ${date}`, "---", "",
    "# 决策", "",
    "> 已经拍板的事和理由（含放弃的方案）。避免下次重复讨论。", "",
  ]);

  seed("backlog.md", [
    "---", "type: role_backlog", `role: ${m.id}`, `updated_at: ${date}`, "---", "",
    "# 待办", "",
    "> 这个角色视角下待推进的事。完成了就删掉或移进 decisions.md。", "",
  ]);
}
