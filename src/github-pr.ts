// PR/MR 工作台：合码闭环（列表 → diff/CI/评论 → approve/merge），双后端——
//   git.provider: "github"（默认）走 gh CLI；  "gitlab" 走 glab CLI（实例取 git.host）。
// 两个清单：等我 review 的 + 我自己开的。列表 60s 缓存，详情/diff 实时拉。
// 忽略机制：带我但不需要我处理的 PR/MR 可忽略（不进角标不进主列表，可恢复）。
// GitLab 没有 request-changes 审查态，该 action 在 gitlab 后端明确报不支持。
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { cfg, DATA, ensureDir, log, run } from "./util.ts";

const IGNORED_FILE = join(DATA, "pr-ignored.json");
let ignoredCache: Set<string> | null = null;

function ignoredSet(): Set<string> {
  if (!ignoredCache) {
    try { ignoredCache = new Set(JSON.parse(readFileSync(IGNORED_FILE, "utf8"))); } catch { ignoredCache = new Set(); }
  }
  return ignoredCache!;
}

export function setPrIgnored(repo: string, number: number, ignore: boolean) {
  const s = ignoredSet();
  const key = `${repo}#${number}`;
  if (ignore) s.add(key); else s.delete(key);
  ensureDir(DATA);
  writeFileSync(IGNORED_FILE, JSON.stringify([...s], null, 2));
  listCache = null; // 下次列表即时生效
}

/** 该 PR/MR 是否被用户忽略（提醒/action 侧共用同一份忽略集） */
export function isPrIgnored(repo: string, number: number): boolean {
  return ignoredSet().has(`${repo}#${number}`);
}

export interface PrItem {
  repo: string;        // github: owner/name；gitlab: group/name
  number: number;      // gitlab 是 MR iid
  title: string;
  author: string;
  updatedAt: string;
  bucket: "review" | "mine";
  // 我的 PR/MR 的可动性：需要我动的（changes/conflict/ci-fail/ready）vs 等别人（waiting）
  state?: "changes" | "conflict" | "ci-fail" | "ready" | "waiting";
  ignored?: boolean;   // 带我但不需要我处理，用户手动忽略
  url?: string;        // 在 git 宿主上的 web 链接，列表卡片直接外链
}

export interface PrDetail {
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  branch: string;
  baseBranch: string;
  additions: number;
  deletions: number;
  mergeable: string;    // MERGEABLE | CONFLICTING | UNKNOWN
  reviewDecision: string; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
  checks: { name: string; state: string }[];
  files: { path: string; additions: number; deletions: number }[];
  comments: { author: string; body: string; at: string }[];
  url: string;
}

let listCache: { at: number; items: PrItem[] } | null = null;

// ---- 后端分发：git.provider（默认 github）；gitlab 的实例 host 取 git.host ----
type Provider = "github" | "gitlab";
function provider(): Provider {
  return String(cfg.git?.provider || "github").toLowerCase() === "gitlab" ? "gitlab" : "github";
}
function glabEnv(): Record<string, string> {
  const host = String(cfg.git?.host || "").trim();
  return host ? { GITLAB_HOST: host } : {};
}

async function cliJson(bin: string, args: string[], timeoutMs = 30_000, env: Record<string, string> = {}): Promise<any> {
  const r = await run([bin, ...args], { timeoutMs, env });
  if (r.code !== 0) throw new Error(r.stderr.slice(0, 200) || `${bin} 命令失败`);
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// 每个 PR/MR 的可动性状态：单独拉详情（并发 6、120s 缓存——列表刷新不重拉没变化的）
const stateCache = new Map<string, { at: number; state: PrItem["state"] }>();

export async function listPrs(force = false): Promise<PrItem[]> {
  if (!force && listCache && Date.now() - listCache.at < 60_000) return listCache.items;
  let items: PrItem[];
  try {
    items = provider() === "gitlab" ? await listPrsGitlab() : await listPrsGithub();
  } catch (e) {
    // 失败时回旧值——列表短暂过期好过角标闪没（gh search 有严格限流）
    if (listCache) { log(`prs fetch failed, serve stale: ${e}`); return listCache.items; }
    throw e;
  }
  // 需要我动的排前面
  const rank = (p: PrItem) => ({ "ci-fail": 0, conflict: 1, changes: 2, ready: 3, waiting: 9 }[p.state || "waiting"] ?? 9);
  const mine_ = items.filter((p) => p.bucket === "mine").sort((a, b) => rank(a) - rank(b));
  const review_ = items.filter((p) => p.bucket === "review");
  items = [...review_, ...mine_];
  listCache = { at: Date.now(), items };
  log(`${provider()} prs: ${items.length}`);
  return items;
}

/** 列表公共收尾：review/mine 去重（review 优先）、忽略标记、mine 的可动性富化 */
async function shapeLists(reviewRaw: PrItem[], mineRaw: PrItem[], enrich: (items: PrItem[]) => Promise<void>): Promise<PrItem[]> {
  const ig = ignoredSet();
  const seen = new Set(reviewRaw.map((p) => `${p.repo}#${p.number}`));
  const mine_ = mineRaw.filter((p) => !seen.has(`${p.repo}#${p.number}`));
  for (const p of [...reviewRaw, ...mine_]) p.ignored = ig.has(`${p.repo}#${p.number}`);
  await enrich(mine_.filter((p) => !p.ignored));   // 忽略的不花 API 查状态
  return [...reviewRaw, ...mine_];
}

// ================= GitHub 后端（gh CLI） =================

async function listPrsGithub(): Promise<PrItem[]> {
  const fields = "repository,number,title,author,updatedAt,url";
  const [review, mine] = await Promise.all([
    cliJson("gh", ["search", "prs", "--review-requested=@me", "--state=open", "--json", fields, "--limit", "30"]),
    cliJson("gh", ["search", "prs", "--author=@me", "--state=open", "--json", fields, "--limit", "30"]),
  ]);
  const map = (arr: any[], bucket: PrItem["bucket"]): PrItem[] =>
    (arr || []).map((p) => ({
      repo: p.repository?.nameWithOwner || "",
      number: p.number,
      title: p.title,
      author: p.author?.login || "",
      updatedAt: p.updatedAt,
      bucket,
      url: p.url || "",
    }));
  return shapeLists(map(review, "review"), map(mine, "mine"), enrichStatesGithub);
}

async function enrichStatesGithub(items: PrItem[]) {
  const CONC = 6;
  const queue = [...items];
  const workers = Array.from({ length: CONC }, async () => {
    let p: PrItem | undefined;
    while ((p = queue.shift())) {
      const key = `${p.repo}#${p.number}`;
      const hit = stateCache.get(key);
      if (hit && Date.now() - hit.at < 120_000) { p.state = hit.state; continue; }
      try {
        const d = await cliJson("gh", ["pr", "view", String(p.number), "-R", p.repo,
          "--json", "reviewDecision,mergeable,statusCheckRollup"], 20_000);
        const checksFail = (d.statusCheckRollup || []).some((c: any) =>
          ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes((c.conclusion || c.state || "").toUpperCase()));
        const checksPending = (d.statusCheckRollup || []).some((c: any) =>
          ["PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED"].includes((c.conclusion || c.state || "PENDING").toUpperCase()));
        p.state =
          checksFail ? "ci-fail"
          : d.mergeable === "CONFLICTING" ? "conflict"
          : d.reviewDecision === "CHANGES_REQUESTED" ? "changes"
          : d.reviewDecision === "APPROVED" && !checksPending ? "ready"
          : "waiting";
      } catch { p.state = "waiting"; }
      stateCache.set(key, { at: Date.now(), state: p.state });
    }
  });
  await Promise.all(workers);
}

async function prDetailGithub(repo: string, number: number): Promise<PrDetail> {
  const p = await cliJson("gh", ["pr", "view", String(number), "-R", repo, "--json",
    "title,body,author,headRefName,baseRefName,additions,deletions,mergeable,reviewDecision,statusCheckRollup,files,comments,url"]);
  if (!p) throw new Error("PR 不存在");
  return {
    repo, number,
    title: p.title,
    body: (p.body || "").slice(0, 4000),
    author: p.author?.login || "",
    branch: p.headRefName,
    baseBranch: p.baseRefName,
    additions: p.additions,
    deletions: p.deletions,
    mergeable: p.mergeable || "UNKNOWN",
    reviewDecision: p.reviewDecision || "",
    checks: (p.statusCheckRollup || []).map((c: any) => ({
      name: c.name || c.context || "",
      state: c.conclusion || c.state || "PENDING",
    })),
    files: (p.files || []).map((f: any) => ({ path: f.path, additions: f.additions, deletions: f.deletions })),
    comments: (p.comments || []).slice(-10).map((c: any) => ({
      author: c.author?.login || "",
      body: (c.body || "").slice(0, 1500),
      at: c.createdAt,
    })),
    url: p.url,
  };
}

async function prDiffGithub(repo: string, number: number): Promise<string> {
  const r = await run(["gh", "pr", "diff", String(number), "-R", repo], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(r.stderr.slice(0, 200));
  return capDiff(r.stdout, "GitHub");
}

async function prActGithub(repo: string, number: number, action: PrAction, body?: string): Promise<string> {
  if (action === "merge") {
    // squash 是团队常见默认；失败信息原样抛给用户（分支保护/CI 未过等）
    const r = await run(["gh", "pr", "merge", String(number), "-R", repo, "--squash", "--delete-branch"], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(r.stderr.slice(0, 300));
    listCache = null;
    return "已合并（squash）";
  }
  const flag = action === "approve" ? "--approve" : action === "request-changes" ? "--request-changes" : "--comment";
  const args = ["pr", "review", String(number), "-R", repo, flag];
  if (body?.trim()) args.push("--body", body.trim());
  else if (action !== "approve") throw new Error("request-changes / comment 需要填写内容");
  const r = await run(["gh", ...args], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(r.stderr.slice(0, 300));
  listCache = null;
  return { approve: "已 Approve", "request-changes": "已请求修改", comment: "已评论" }[action]!;
}

// ================= GitLab 后端（glab CLI） =================

const proj = (repo: string) => encodeURIComponent(repo);

let meCache: string | null = null;
/** token 用户名：GitLab 全局 MR 列表只含该用户有成员身份的项目，要用个人 PAT 登录才有真实列表 */
async function glabMe(): Promise<string> {
  if (!meCache) {
    const u = await cliJson("glab", ["api", "user"], 30_000, glabEnv());
    meCache = u?.username || "";
  }
  return meCache!;
}

async function listPrsGitlab(): Promise<PrItem[]> {
  const who = encodeURIComponent(await glabMe());
  const env = glabEnv();
  const [review, mine] = await Promise.all([
    cliJson("glab", ["api", `merge_requests?state=opened&reviewer_username=${who}&order_by=updated_at&per_page=30`], 30_000, env),
    cliJson("glab", ["api", `merge_requests?state=opened&author_username=${who}&order_by=updated_at&per_page=30`], 30_000, env),
  ]);
  const map = (arr: any[], bucket: PrItem["bucket"]): PrItem[] =>
    (arr || []).map((m) => ({
      repo: (m.references?.full || "").split("!")[0],
      number: m.iid,
      title: m.title,
      author: m.author?.username || "",
      updatedAt: m.updated_at,
      bucket,
      url: m.web_url || "",
    }));
  return shapeLists(map(review, "review"), map(mine, "mine"), enrichStatesGitlab);
}

async function enrichStatesGitlab(items: PrItem[]) {
  const CONC = 6;
  const queue = [...items];
  const env = glabEnv();
  const workers = Array.from({ length: CONC }, async () => {
    let p: PrItem | undefined;
    while ((p = queue.shift())) {
      const key = `${p.repo}#${p.number}`;
      const hit = stateCache.get(key);
      if (hit && Date.now() - hit.at < 120_000) { p.state = hit.state; continue; }
      try {
        const d = await cliJson("glab", ["api", `projects/${proj(p.repo)}/merge_requests/${p.number}`], 20_000, env);
        p.state = stateOfGitlab(d);
      } catch { p.state = "waiting"; }
      stateCache.set(key, { at: Date.now(), state: p.state });
    }
  });
  await Promise.all(workers);
}

/** MR 详情 → 可动性：CI 挂 / 冲突 / 讨论未解决 / 就绪 / 等别人 */
function stateOfGitlab(d: any): PrItem["state"] {
  const pipe = d.head_pipeline?.status;
  const ciFail = pipe === "failed" || pipe === "canceled";
  const ciPending = !!pipe && !["success", "failed", "canceled", "skipped"].includes(pipe);
  if (ciFail) return "ci-fail";
  if (d.has_conflicts || d.merge_status === "cannot_be_merged") return "conflict";
  if (d.detailed_merge_status === "discussions_not_resolved") return "changes";
  if (d.merge_status === "can_be_merged" && !ciPending && !["not_approved", "draft_status", "external_status_checks"].includes(d.detailed_merge_status)) return "ready";
  return "waiting";
}

/** 从 diff 文本数加减行（GitLab 的 diff 字段是纯 @@ hunk，无 ---/+++ 文件头） */
function diffStat(diff: string): { additions: number; deletions: number } {
  let a = 0, d = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) a++;
    else if (line.startsWith("-")) d++;
  }
  return { additions: a, deletions: d };
}

function mergeableOfGitlab(d: any): PrDetail["mergeable"] {
  if (d.merge_status === "can_be_merged") return "MERGEABLE";
  if (d.has_conflicts || d.merge_status === "cannot_be_merged") return "CONFLICTING";
  return "UNKNOWN";
}

/** MR 详情 → reviewDecision（GitLab 无独立 review 状态，从合并状态推导） */
function reviewDecisionOfGitlab(d: any): string {
  if (d.detailed_merge_status === "discussions_not_resolved") return "CHANGES_REQUESTED";
  if (d.detailed_merge_status === "not_approved") return "REVIEW_REQUIRED";
  if (stateOfGitlab(d) === "ready") return "APPROVED";
  return "";
}

async function prDetailGitlab(repo: string, number: number): Promise<PrDetail> {
  const base = `projects/${proj(repo)}/merge_requests/${number}`;
  const env = glabEnv();
  const [d, ch, notes] = await Promise.all([
    cliJson("glab", ["api", base], 30_000, env),
    cliJson("glab", ["api", `${base}/changes`], 30_000, env),
    cliJson("glab", ["api", `${base}/notes?per_page=10&sort=desc&order_by=created_at`], 30_000, env),
  ]);
  if (!d) throw new Error("MR 不存在");
  const files = (ch?.changes || []).map((c: any) => ({
    path: c.new_path || c.old_path || "",
    ...diffStat(c.diff || ""),
  }));
  return {
    repo, number,
    title: d.title,
    body: (d.description || "").slice(0, 4000),
    author: d.author?.username || "",
    branch: d.source_branch,
    baseBranch: d.target_branch,
    additions: files.reduce((s: number, f: any) => s + f.additions, 0),
    deletions: files.reduce((s: number, f: any) => s + f.deletions, 0),
    mergeable: mergeableOfGitlab(d),
    reviewDecision: reviewDecisionOfGitlab(d),
    checks: d.head_pipeline ? [{ name: `pipeline #${d.head_pipeline.iid}`, state: d.head_pipeline.status }] : [],
    files,
    comments: (Array.isArray(notes) ? notes : []).filter((n: any) => !n.system).reverse()
      .map((n: any) => ({ author: n.author?.username || "", body: (n.body || "").slice(0, 1500), at: n.created_at })),
    url: d.web_url,
  };
}

async function prDiffGitlab(repo: string, number: number): Promise<string> {
  const ch = await cliJson("glab", ["api", `projects/${proj(repo)}/merge_requests/${number}/changes`], 30_000, glabEnv());
  const text = (ch?.changes || []).map((c: any) => c.diff || "").join("\n");
  return capDiff(text, "GitLab");
}

async function prActGitlab(repo: string, number: number, action: PrAction, body?: string): Promise<string> {
  if (action === "request-changes") throw new Error("GitLab 没有 request-changes 审查态，请改用评论或 approve");
  const env = glabEnv();
  if (action === "merge") {
    // squash 是团队常见默认；失败信息原样抛给用户（分支保护/CI 未过等）
    const r = await run(["glab", "mr", "merge", String(number), "-R", repo, "--squash", "--remove-source-branch", "--yes"], { timeoutMs: 60_000, env });
    if (r.code !== 0) throw new Error(r.stderr.slice(0, 300));
    listCache = null;
    return "已合并（squash）";
  }
  if (action === "approve") {
    const r = await run(["glab", "mr", "approve", String(number), "-R", repo], { timeoutMs: 30_000, env });
    if (r.code !== 0) throw new Error(r.stderr.slice(0, 300));
    listCache = null;
    return "已 Approve";
  }
  // comment：走 API 发 note（glab mr note 会拉起交互）
  if (!body?.trim()) throw new Error("comment 需要填写内容");
  const r = await run(["glab", "api", `projects/${proj(repo)}/merge_requests/${number}/notes`, "-f", `body=${body.trim()}`], { timeoutMs: 30_000, env });
  if (r.code !== 0) throw new Error(r.stderr.slice(0, 300));
  listCache = null;
  return "已评论";
}

// ================= 公共出口 =================

/** diff 上限 200KB——超大 PR/MR 别拖垮客户端，截断并注明 */
function capDiff(text: string, hostLabel: string): string {
  const CAP = 200 * 1024;
  return text.length > CAP ? text.slice(0, CAP) + `\n\n…(diff 过大已截断，完整版去 ${hostLabel} 看)` : text;
}

export async function prDetail(repo: string, number: number): Promise<PrDetail> {
  return provider() === "gitlab" ? prDetailGitlab(repo, number) : prDetailGithub(repo, number);
}

export async function prDiff(repo: string, number: number): Promise<string> {
  return provider() === "gitlab" ? prDiffGitlab(repo, number) : prDiffGithub(repo, number);
}

export type PrAction = "approve" | "request-changes" | "comment" | "merge";

export async function prAct(repo: string, number: number, action: PrAction, body?: string): Promise<string> {
  return provider() === "gitlab" ? prActGitlab(repo, number, action, body) : prActGithub(repo, number, action, body);
}
