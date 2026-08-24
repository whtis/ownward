// GitHub PR 工作台：合码闭环（列表 → diff/CI/评论 → approve/merge），全部走 gh CLI。
// 两个清单：等我 review 的 + 我自己开的。列表 60s 缓存，详情/diff 实时拉。
// 忽略机制：带我但不需要我处理的 PR 可忽略（不进角标不进主列表，可恢复）。
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA, ensureDir, log, run } from "./util.ts";

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

/** 该 PR 是否被用户忽略（提醒/action 侧共用同一份忽略集） */
export function isPrIgnored(repo: string, number: number): boolean {
  return ignoredSet().has(`${repo}#${number}`);
}

export interface PrItem {
  repo: string;        // owner/name
  number: number;
  title: string;
  author: string;
  updatedAt: string;
  bucket: "review" | "mine";
  // 我的 PR 的可动性：需要我动的（changes/conflict/ci-fail/ready）vs 等别人（waiting）
  state?: "changes" | "conflict" | "ci-fail" | "ready" | "waiting";
  ignored?: boolean;   // 带我但不需要我处理，用户手动忽略
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

async function ghJson(args: string[], timeoutMs = 30_000): Promise<any> {
  const r = await run(["gh", ...args], { timeoutMs });
  if (r.code !== 0) throw new Error(r.stderr.slice(0, 200) || "gh 命令失败");
  try { return JSON.parse(r.stdout); } catch { return null; }
}

export async function listPrs(force = false): Promise<PrItem[]> {
  if (!force && listCache && Date.now() - listCache.at < 60_000) return listCache.items;
  const fields = "repository,number,title,author,updatedAt";
  let review: any, mine: any;
  try {
    [review, mine] = await Promise.all([
      ghJson(["search", "prs", "--review-requested=@me", "--state=open", "--json", fields, "--limit", "30"]),
      ghJson(["search", "prs", "--author=@me", "--state=open", "--json", fields, "--limit", "30"]),
    ]);
  } catch (e) {
    // gh search API 有严格限流，失败时回旧值——列表短暂过期好过角标闪没
    if (listCache) { log(`gh prs fetch failed, serve stale: ${e}`); return listCache.items; }
    throw e;
  }
  const map = (arr: any[], bucket: PrItem["bucket"]): PrItem[] =>
    (arr || []).map((p) => ({
      repo: p.repository?.nameWithOwner || "",
      number: p.number,
      title: p.title,
      author: p.author?.login || "",
      updatedAt: p.updatedAt,
      bucket,
    }));
  // 自己的 PR 也可能同时 review-requested（团队规则），去重以 review 桶优先
  const ig = ignoredSet();
  const review_ = map(review, "review");
  const seen = new Set(review_.map((p) => `${p.repo}#${p.number}`));
  const mine_ = map(mine, "mine").filter((p) => !seen.has(`${p.repo}#${p.number}`));
  for (const p of [...review_, ...mine_]) p.ignored = ig.has(`${p.repo}#${p.number}`);
  await enrichStates(mine_.filter((p) => !p.ignored)); // 忽略的不花 API 查状态
  // 需要我动的排前面
  const rank = (p: PrItem) => ({ "ci-fail": 0, conflict: 1, changes: 2, ready: 3, waiting: 9 }[p.state || "waiting"] ?? 9);
  mine_.sort((a, b) => rank(a) - rank(b));
  const items = [...review_, ...mine_];
  listCache = { at: Date.now(), items };
  log(`gh prs: ${items.length}`);
  return items;
}

// 每个 PR 的可动性状态：单独 gh pr view 拉（并发 6、120s 缓存——列表刷新不重拉没变化的）
const stateCache = new Map<string, { at: number; state: PrItem["state"] }>();

async function enrichStates(items: PrItem[]) {
  const CONC = 6;
  const queue = [...items];
  const workers = Array.from({ length: CONC }, async () => {
    let p: PrItem | undefined;
    while ((p = queue.shift())) {
      const key = `${p.repo}#${p.number}`;
      const hit = stateCache.get(key);
      if (hit && Date.now() - hit.at < 120_000) { p.state = hit.state; continue; }
      try {
        const d = await ghJson(["pr", "view", String(p.number), "-R", p.repo,
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

export async function prDetail(repo: string, number: number): Promise<PrDetail> {
  const p = await ghJson(["pr", "view", String(number), "-R", repo, "--json",
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

/** diff 上限 200KB——超大 PR 别拖垮客户端，截断并注明 */
export async function prDiff(repo: string, number: number): Promise<string> {
  const r = await run(["gh", "pr", "diff", String(number), "-R", repo], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(r.stderr.slice(0, 200));
  const CAP = 200 * 1024;
  return r.stdout.length > CAP ? r.stdout.slice(0, CAP) + "\n\n…(diff 过大已截断，完整版去 GitHub 看)" : r.stdout;
}

export type PrAction = "approve" | "request-changes" | "comment" | "merge";

export async function prAct(repo: string, number: number, action: PrAction, body?: string): Promise<string> {
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
