// 项目知识层：<scope>/projects/<slug>/ 是项目的唯一真相（README/decisions/operations），
// 项目专家在对话里得出的结论只能落成候选 <scope>/projects/<slug>/_candidates/<id>.md，
// 由人点「晋升」才追加进正式 markdown。与 roles.ts 的候选门是同一条规矩，两处都不许自动化掉。
//
// 为什么单独一个文件而不是塞进 roles.ts：候选归属不同（项目 ≠ 角色）、目标文件不同、
// 路径根不同。共用的只有"人工晋升门"这条规矩和 vault 根（activeVault，单测注入同一个根）。
//
// 三条硬约束（与 roles.ts 同源）：
//   1. scope 物理隔离——项目候选只落在调用方给定 scope 的 projects/ 下；
//   2. 路径白名单——slug / candidateId 先过正则，落盘前再复核 startsWith(<scope>/projects/ + "/")；
//   3. 人工晋升门——LLM/对话只能写 _candidates/，正式 markdown 只有人点晋升才被追加。
import { isStrictlyWithin } from "./path-within.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { projectDir, projectsDir, type Scope } from "./paths.ts";
import { activeVault, type Fail, type Result } from "./roles.ts";
import { fmt, log } from "./util.ts";

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CANDIDATE_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MAX_TEXT = 1000, MAX_EVIDENCE = 2000, MAX_CANDIDATES = 200;

/** 项目的正式记忆三件套。README 是项目现状的唯一真相，另两份分流决策与运维——
 *  白名单写死在这里：晋升目标是拼文件名的唯一变量，绝不接受自由字符串。 */
export const PROJECT_PROMOTE_TARGETS = ["README", "decisions", "operations"] as const;
export type ProjectPromoteTarget = typeof PROJECT_PROMOTE_TARGETS[number];
const TARGET_TITLE: Record<ProjectPromoteTarget, string> = {
  README: "项目现状", decisions: "项目决策", operations: "部署与排障",
};

export interface ProjectCandidate {
  id: string;
  project: string;
  scope: Scope;
  text: string;
  evidence: string;
  sourceChat: string;
  sourceRole: string;
  createdAt: string;
  status: string;
}

const fail = (code: Fail["code"], msg: string): Fail => ({ ok: false, code, msg });
/** tsconfig 关了 strict，判别式联合不会自动收窄——同 roles.ts，用显式守卫 */
const isFail = (v: unknown): v is Fail => !!v && (v as any).ok === false;
const len = (s: string) => [...s].length;   // 中文按字计数，同 roles.ts

/** 项目目录 + 三道门：slug 白名单 → <scope>/projects/ 字符串前缀复核 → realpath 复核。
 *  第三道是给软链准备的：字符串前缀拦不住 projects/foo -> /etc 这种目录软链（同步工具、
 *  手工 ln 都能造出来），跟着写下去就把项目记忆写到 vault 外面了。
 *  vault 根自己是软链的情况也照顾到了：两边都取 realpath 再比。
 *  不存在的项目一律 not_found：候选目录不该由候选创建凭空造出一个项目。 */
function projectHome(slug: string, scope: Scope): { ok: true; dir: string } | Fail {
  const s = String(slug ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(s)) return fail("invalid", `项目 slug 不合法：${String(slug).slice(0, 40)}`);
  const { root, scopes } = activeVault();
  if (!scopes.includes(scope)) return fail("invalid", `scope 不合法：${String(scope).slice(0, 20)}`);
  const base = projectsDir(scope, root);
  const dir = projectDir(s, scope, root);
  if (!isStrictlyWithin(base, dir)) return fail("invalid", "项目路径越界");
  if (!existsSync(dir)) return fail("not_found", `vault 里没有项目 ${s}（${scope ? scope + "/" : ""}projects/${s}/ 不存在）`);
  try {
    if (realpathSync(dir) !== join(realpathSync(base), s)) {
      log(`project-memory: 拒绝 ${s}——目录软链指到了 ${scope ? scope + "/" : ""}projects/ 之外`);
      return fail("invalid", `项目 ${s} 的目录是指向 vault 之外的软链，拒绝写入（项目记忆只住 vault）`);
    }
  } catch (e) {
    return fail("invalid", `项目 ${s} 的目录读不到（软链断了？）：${String(e).slice(0, 80)}`);
  }
  return { ok: true, dir };
}

function candidatesDir(projectHomeDir: string): string {
  return join(projectHomeDir, "_candidates");
}

/** 候选文件路径：候选 id 白名单 + 再一次 projects/ 前缀复核（多查一次成本是零） */
function candidateFile(dir: string, scope: Scope, cid: string): string | null {
  if (!CANDIDATE_ID_RE.test(cid)) return null;
  const f = join(candidatesDir(dir), `${cid}.md`);
  const { root } = activeVault();
  return isStrictlyWithin(projectsDir(scope, root), f) ? f : null;
}

export function createProjectCandidate(
  slug: string,
  scope: Scope,
  input: { text?: string; evidence?: string; sourceChatId?: string; sourceRoleId?: string },
): Result<{ candidate: ProjectCandidate }> {
  const home = projectHome(slug, scope);
  if (isFail(home)) return home;
  const project = String(slug).trim().toLowerCase();

  const text = String(input?.text ?? "").trim();
  if (!text) return fail("invalid", "候选内容为空");
  if (len(text) > MAX_TEXT) return fail("invalid", `候选内容最多 ${MAX_TEXT} 字`);
  const evidence = String(input?.evidence ?? "").trim().slice(0, MAX_EVIDENCE);
  const clean = (v: unknown) => String(v ?? "").trim().slice(0, 64).replace(/[^\w.:-]/g, "") || "-";
  const sourceChat = clean(input?.sourceChatId);
  const sourceRole = clean(input?.sourceRoleId);

  const dir = candidatesDir(home.dir);
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).filter((f) => f.endsWith(".md")).length >= MAX_CANDIDATES) {
    return fail("conflict", `项目 ${project} 的候选已达上限 ${MAX_CANDIDATES} 条，先晋升或丢弃一些`);
  }

  const createdAt = new Date().toISOString();
  const day = fmt(new Date(), "date").replaceAll("-", "");
  let cid = "", file = "";
  for (let i = 0; i < 20 && !file; i++) {
    cid = `${day}-${Math.random().toString(36).slice(2, 8)}`;
    const f = candidateFile(home.dir, scope, cid);
    if (f && !existsSync(f)) file = f;
  }
  if (!file) return fail("conflict", "候选 id 生成失败，请重试");

  writeFileSync(file, [
    "---",
    `project: ${project}`,
    `source_chat: ${sourceChat}`,
    `source_role: ${sourceRole}`,
    `created_at: ${createdAt}`,
    "status: pending",
    "---",
    "",
    text,
    "",
    ...(evidence ? [`> 证据：${evidence}`, ""] : []),
  ].join("\n"));
  log(`project-memory: candidate ${scope ? scope + "/" : ""}${project}/${cid}（待人工晋升）`);
  return {
    ok: true,
    candidate: { id: cid, project, scope, text, evidence, sourceChat, sourceRole, createdAt, status: "pending" },
  };
}

function parseCandidate(cid: string, project: string, scope: Scope, raw: string): ProjectCandidate {
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
    project: fm.get("project") || project,
    scope,
    text: (ev ? body.slice(0, ev.index).trim() : body).slice(0, MAX_TEXT * 2),
    evidence: (ev?.[1] || "").trim().slice(0, MAX_EVIDENCE),
    sourceChat: fm.get("source_chat") || "-",
    sourceRole: fm.get("source_role") || "-",
    createdAt: fm.get("created_at") || "",
    status: fm.get("status") || "pending",
  };
}

export function listProjectCandidates(slug: string, scope: Scope): Result<{ candidates: ProjectCandidate[] }> {
  const home = projectHome(slug, scope);
  if (isFail(home)) return home;
  const project = String(slug).trim().toLowerCase();
  const dir = candidatesDir(home.dir);
  if (!existsSync(dir)) return { ok: true, candidates: [] };
  const out: ProjectCandidate[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const cid = f.slice(0, -3);
    if (!CANDIDATE_ID_RE.test(cid)) { log(`project-memory: 跳过异常候选文件 ${project}/${f}`); continue; }
    try { out.push(parseCandidate(cid, project, scope, readFileSync(join(dir, f), "utf8"))); }
    catch (e) { log(`project-memory: 候选读取失败 ${project}/${f}: ${e}`); }
  }
  return { ok: true, candidates: out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) };
}

/** 人工晋升：候选内容追加进项目正式 markdown，然后删掉候选文件。
 *  这是三道人工审批门之一——不许被 LLM/自动流程调用（别在 chat/agent 里加调用点）。
 *
 *  两个写入风险，都在这里处理掉：
 *  1) 读-改-写整份重写，中途崩就把项目 README（项目唯一真相）截断成半份 → 临时文件 + rename，
 *     rename 在同一文件系统内是原子的：要么还是旧全文，要么已是新全文；
 *  2) 追加成功、删候选失败（权限/同步锁），旧写法会报"已晋升"然后下次晋升重复追加 →
 *     删除失败如实说出来（不许假成功），候选还在，用户能看见也能自己丢弃。
 *  并发：全程同步 fs 调用、没有 await，单个 daemon 内不会与另一次晋升交错。 */
export function promoteProjectCandidate(
  slug: string, scope: Scope, candidateId: string, target: string,
): Result<{ target: string; msg: string }> {
  const home = projectHome(slug, scope);
  if (isFail(home)) return home;
  const project = String(slug).trim().toLowerCase();
  if (!(PROJECT_PROMOTE_TARGETS as readonly string[]).includes(target)) {
    return fail("invalid", `晋升目标只能是 ${PROJECT_PROMOTE_TARGETS.join("/")}`);
  }
  const src = candidateFile(home.dir, scope, String(candidateId || ""));
  if (!src) return fail("invalid", "候选 id 不合法");
  if (!existsSync(src)) return fail("not_found", "候选不存在（可能已被晋升或丢弃）");

  const dest = join(home.dir, `${target}.md`);
  const { root } = activeVault();
  if (!isStrictlyWithin(projectsDir(scope, root), dest)) return fail("invalid", "目标路径越界");
  const tmp = `${dest}.tmp`;

  const cand = parseCandidate(String(candidateId), project, scope, readFileSync(src, "utf8"));
  const date = fmt(new Date(), "date");
  const entry = [
    `- ${cand.text.replace(/\n+/g, " ").trim()}`,
    `  - 来源：对话 ${cand.sourceChat}${cand.sourceRole !== "-" ? ` · 角色 ${cand.sourceRole}` : ""} · 晋升于 ${date}`,
    ...(cand.evidence ? [`  - 证据：「${cand.evidence.replace(/\n+/g, " ").trim()}」`] : []),
    "",
  ].join("\n");
  // README 通常由收割建好；decisions/operations 第一次晋升时才出现，给个标题骨架
  const body = existsSync(dest)
    ? readFileSync(dest, "utf8").replace(/\s*$/, "\n")
    : ["---", "type: project_memory", `project: ${project}`, ...(scope ? [`scope: ${scope}`] : []), `updated_at: ${date}`, "---", "",
       `# ${project} · ${TARGET_TITLE[target as ProjectPromoteTarget]}`, ""].join("\n");
  // 临时文件 + rename：崩在半路时项目 README 要么是旧全文、要么是新全文，不会剩半份
  try {
    writeFileSync(tmp, `${body}\n${entry}`);
    renameSync(tmp, dest);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* 清不掉就留着，正式文件没被动过 */ }
    log(`project-memory: 晋升写入失败 ${project}/${target}.md: ${e}`);
    return fail("conflict", `写 ${project}/${target}.md 失败（候选还在，可重试）：${String(e).slice(0, 120)}`);
  }
  // 删候选失败不当成功报：不然下次晋升会把同一条再追加一遍
  try { rmSync(src); } catch (e) {
    log(`project-memory: 候选删除失败 ${project}/${candidateId}: ${e}`);
    return {
      ok: true, target,
      msg: `已晋升到 ${project}/${target}.md，但候选文件没删掉（${String(e).slice(0, 80)}）——请手动丢弃，否则会重复晋升`,
    };
  }
  log(`project-memory: promoted ${scope ? scope + "/" : ""}${project}/${candidateId} → ${target}.md`);
  // 只回目标名，不回绝对路径：客户端拿不到 vault 的磁盘布局（要打开文件走 /api/vault/file）
  return { ok: true, target, msg: `已晋升到 ${project}/${target}.md` };
}

/** 丢弃候选：也是人工动作，删完就没了（正式记忆没被碰过） */
export function dismissProjectCandidate(slug: string, scope: Scope, candidateId: string): Result<{ msg: string }> {
  const home = projectHome(slug, scope);
  if (isFail(home)) return home;
  const f = candidateFile(home.dir, scope, String(candidateId || ""));
  if (!f) return fail("invalid", "候选 id 不合法");
  if (!existsSync(f)) return fail("not_found", "候选不存在（可能已被晋升或丢弃）");
  rmSync(f);
  log(`project-memory: dismissed ${scope ? scope + "/" : ""}${String(slug).toLowerCase()}/${candidateId}`);
  return { ok: true, msg: "已丢弃" };
}
