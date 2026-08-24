// 三态审批的记忆与审计层：把「批准/拒绝」升级为「本次 / 总是批准 / 拒绝」。
// 「总是批准」按「操作类型 + 对象」记忆成规则（会话级或全局），命中的请求直接放行，
// 不再打断长任务；每一次决策（自动/人工/超时）都写审计流，可回溯、可撤销。
// 规则存 data/approval-rules.json，审计存 data/approval-audit.jsonl。
import { appendFileSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { DATA, ensureDir, log } from "./util.ts";

export type RuleScope = "session" | "global";
export type RuleKind = "bash" | "tool";

export interface ApprovalRule {
  id: string;              // 唯一 id（时间戳 + 随机）
  scope: RuleScope;        // session=仅本会话 / global=全局
  sessionId?: string;      // scope=session 时归属的任务/会话 id
  kind: RuleKind;          // bash（命令）/ tool（工具名）
  pattern: string;         // 归纳出的匹配键：bash 取命令首词/子命令，tool 取工具名
  createdAt: string;
}

// 决策审计条目：谁在什么时候对哪个请求做了什么决定
export interface DecisionAudit {
  at: string;
  taskId: string;
  requestId?: string;
  toolName: string;
  pattern: string;
  kind: RuleKind;
  decision: "auto-allow" | "allow" | "deny" | "timeout";
  by: "rule" | "user" | "system";
  ruleScope?: RuleScope;   // 命中/新建规则时的作用域
  detail?: string;         // 命令摘要等
}

const RULES_FILE = join(DATA, "approval-rules.json");
const AUDIT_FILE = join(DATA, "approval-audit.jsonl");

// 高危模式：与 agent-session 的判断保持一致，用于归纳 bash 的高危 pattern。
// 顺序敏感——更危险/更具体的在前（force-push 必须先于普通 push 命中，否则会被归并成同一条自动批准规则，
// 「总是批准 git push」就会顺带放行 force-push；codex review 查出的问题）。
const RISKY_KEYS: { re: RegExp; key: string }[] = [
  // git push 允许中间夹 -C <dir>/其它 flag；force-push 单独成规则
  { re: /\bgit\b[^\n]*\bpush\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/, key: "git push --force" },
  { re: /\bgit\b[^\n]*\bpush\b/, key: "git push" },
  { re: /\bsudo\b/, key: "sudo" },
  { re: /\brm\s+-[a-zA-Z]*[rRfF][a-zA-Z]*\b/, key: "rm -rf" },  // 兜住 rm -rf . / rm -rf -- / / rm -fr / rm -Rf 等变体
  { re: /\blaunchctl\b/, key: "launchctl" },
  { re: /\bshutdown\b/, key: "shutdown" },
  { re: /\breboot\b/, key: "reboot" },
  { re: /\bdiskutil\b/, key: "diskutil" },
  { re: /\bmkfs\b/, key: "mkfs" },
];

// 首词带子命令的工具（git/npm 等）：记忆到「二级命令」粒度更贴合「操作类型+对象」
const MULTI_WORD = new Set([
  "git", "npm", "pnpm", "yarn", "bun", "docker", "kubectl",
  "brew", "cargo", "go", "make", "systemctl", "launchctl",
]);

let cache: ApprovalRule[] | null = null;

function load(): ApprovalRule[] {
  if (!cache) {
    try { cache = JSON.parse(readFileSync(RULES_FILE, "utf8")); } catch { cache = []; }
  }
  return cache!;
}

function save() {
  ensureDir(DATA);
  writeFileSync(RULES_FILE, JSON.stringify(cache, null, 2));
}

/** 从工具名 + 入参归纳出 { kind, pattern }：bash 取命令高危键/首词（子命令工具取二级词），其它工具取工具名 */
export function patternFor(toolName: string, input: any): { kind: RuleKind; pattern: string } {
  if (toolName === "Bash") {
    const cmd = String(input?.command || "").trim();
    for (const { re, key } of RISKY_KEYS) if (re.test(cmd)) return { kind: "bash", pattern: key };
    const words = cmd.split(/\s+/).filter(Boolean);
    const first = words[0] || "";
    if (MULTI_WORD.has(first) && words[1]) return { kind: "bash", pattern: `${first} ${words[1]}` };
    return { kind: "bash", pattern: first || "(空命令)" };
  }
  return { kind: "tool", pattern: toolName };
}

/** 命中任一自动批准规则？（scope=global 全局命中；scope=session 需 sessionId 匹配） */
export function matchRule(sessionId: string, toolName: string, input: any): ApprovalRule | null {
  const { kind, pattern } = patternFor(toolName, input);
  for (const r of load()) {
    if (r.kind !== kind || r.pattern !== pattern) continue;
    if (r.scope === "global") return r;
    if (r.scope === "session" && r.sessionId === sessionId) return r;
  }
  return null;
}

/** 新建一条自动批准规则；同 scope+sessionId+kind+pattern 已存在则复用，避免重复堆积 */
export function addRule(args: { scope: RuleScope; sessionId?: string; kind: RuleKind; pattern: string }): ApprovalRule {
  const list = load();
  const exist = list.find((r) =>
    r.scope === args.scope && r.kind === args.kind && r.pattern === args.pattern &&
    (args.scope === "global" || r.sessionId === args.sessionId));
  if (exist) return exist;
  const rule: ApprovalRule = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    scope: args.scope,
    sessionId: args.scope === "session" ? args.sessionId : undefined,
    kind: args.kind,
    pattern: args.pattern,
    createdAt: new Date().toISOString(),
  };
  list.push(rule);
  save();
  log(`approval rule added: [${rule.scope}] ${rule.kind}:${rule.pattern}${rule.sessionId ? ` @${rule.sessionId}` : ""}`);
  return rule;
}

/** 列出全部规则（新→旧） */
export function listRules(): ApprovalRule[] {
  return [...load()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 撤销一条规则；返回是否命中 */
export function revokeRule(id: string): boolean {
  const list = load();
  const n = list.length;
  cache = list.filter((r) => r.id !== id);
  if (cache.length === n) return false;
  save();
  log(`approval rule revoked: ${id}`);
  return true;
}

/** 追加一条决策审计（jsonl 追加写，失败不阻塞主流程） */
export function logDecision(entry: Omit<DecisionAudit, "at">) {
  try {
    ensureDir(DATA);
    appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* 审计写不进不影响审批本身 */ }
}
