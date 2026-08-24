// vault 路径唯一真相。所有落盘目录都从 config.vault.root 派生——
// 别在业务文件里再写 expandHome("~/Documents/...")，那会让换目录变成全仓库搜索替换。
//
// 目录布局（scope 为空时中间那层不存在，全部平铺在 root 下）：
//   <root>/ownward/YYYY-MM-DD.md          triage 摘要（ownward 自己的日志）
//   <root>/<scope>/inbox/YYYY-MM-DD.md    会话收割（按天）
//   <root>/<scope>/projects/<slug>/       项目知识层（README 是项目唯一真相 + log/YYYY-MM.md）
//   <root>/<scope>/daily/YYYY-MM-DD.md    日报
//   <root>/<scope>/flights/               任务飞行记录
//   <root>/<scope>/memory/                Memory 层（文件即真相）
//   <root>/<scope>/roles/<role-id>/       Role 层（role.json + 人类可编辑的 markdown + _candidates/）
//   <root>/research/  <root>/staging/  <root>/investing/thesis/
import { isStrictlyWithin } from "./path-within.ts";
import { join } from "path";
import { cfg, ensureDir, expandHome } from "./util.ts";

export const VAULT_ROOT = expandHome(cfg.vault?.root || "~/Documents/ownward-vault");

/** 工作/私人物理分流的开关：配了 workRemoteMatch 才分流，否则所有内容平铺在 root 下。
 *  单人自用不需要分流；只有「公司文档只能取材工作内容」这种需求才打开。 */
export const SCOPES_ON = !!String(cfg.vault?.workRemoteMatch || "").trim();
export const WORK_REMOTE_MATCH: string = String(cfg.vault?.workRemoteMatch || "").trim();
/** 分流排除：远程含匹配串但仍按私人处理的子串（如公司组织名下的个人项目 "example-org/ownward"）。
 *  只在 SCOPES_ON 时有意义。 */
export const WORK_REMOTE_EXCLUDE: string[] = (Array.isArray(cfg.vault?.workRemoteExclude) ? cfg.vault.workRemoteExclude : [])
  .map((s: unknown) => String(s).trim()).filter(Boolean);

/** 分流关闭时 scope 恒为空串，scopeDir 退化成 root——调用方不用到处写 if */
export type Scope = "work" | "private" | "";
export const WORK_SCOPE: Scope = SCOPES_ON ? "work" : "";

/** 纯函数：按 git 远程文本（`git remote -v` 输出或单个 URL）判 scope。
 *  含匹配串且不含任何排除串 = work；含排除串或不含匹配串 = private。注入参数只为单测。 */
export function scopeForRemoteText(remoteText: string, match: string, exclude: string[]): Scope {
  const t = remoteText || "";
  if (!match || !t.includes(match)) return "private";
  return exclude.some((x) => x && t.includes(x)) ? "private" : "work";
}

/** 生产入口：没配 workRemoteMatch = 不分流，恒为 ""。 */
export function scopeForRemote(remoteText: string): Scope {
  if (!SCOPES_ON) return "";
  return scopeForRemoteText(remoteText, WORK_REMOTE_MATCH, WORK_REMOTE_EXCLUDE);
}
export const ALL_SCOPES: Scope[] = SCOPES_ON ? ["work", "private"] : [""];

/** root 形参只为可注入根目录的单测存在（roles.test.ts 用临时 vault）——
 *  业务代码一律省略它，走 VAULT_ROOT 这个唯一真相，别把它当"支持多 vault"。 */
export function scopeDir(scope: Scope = WORK_SCOPE, root: string = VAULT_ROOT): string {
  return scope ? join(root, scope) : root;
}

export const OWNWARD_DIR = join(VAULT_ROOT, "ownward");
export const RESEARCH_DIR = join(VAULT_ROOT, "research");
export const STAGING_DIR = join(VAULT_ROOT, "staging");
export const THESIS_DIR = join(VAULT_ROOT, "investing", "thesis");

export const inboxDir = (scope: Scope = WORK_SCOPE) => join(scopeDir(scope), "inbox");
export const dailyDir = (scope: Scope = WORK_SCOPE) => join(scopeDir(scope), "daily");
export const flightsDir = (scope: Scope = WORK_SCOPE) => join(scopeDir(scope), "flights");
export const memoryDir = (scope: Scope = WORK_SCOPE) => join(scopeDir(scope), "memory");
export const projectsDir = (scope: Scope = WORK_SCOPE, root: string = VAULT_ROOT) => join(scopeDir(scope, root), "projects");
export const projectDir = (slug: string, scope: Scope = WORK_SCOPE, root: string = VAULT_ROOT) => join(projectsDir(scope, root), slug);

/** Role 层：角色跟随 scope 物理隔离（work 角色的目录永远不在 private 下，反之亦然） */
export const rolesDir = (scope: Scope = WORK_SCOPE, root: string = VAULT_ROOT) => join(scopeDir(scope, root), "roles");
export const roleDir = (id: string, scope: Scope = WORK_SCOPE, root: string = VAULT_ROOT) => join(rolesDir(scope, root), id);

/** vault 相对路径（客户端展示 + 写入越界校验都用它，别各自算） */
export function vaultRelative(abs: string): string | null {
  if (abs === VAULT_ROOT) return "";
  return isStrictlyWithin(VAULT_ROOT, abs) ? abs.slice(VAULT_ROOT.length + 1) : null;
}

/** daemon 启动时建一次目录骨架：新用户第一次跑不会因为目录不存在而静默写失败 */
export function ensureVault() {
  ensureDir(OWNWARD_DIR);
  ensureDir(RESEARCH_DIR);
  for (const s of ALL_SCOPES) {
    ensureDir(inboxDir(s));
    ensureDir(projectsDir(s));
    ensureDir(memoryDir(s));
    ensureDir(rolesDir(s));
  }
}
