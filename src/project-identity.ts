// 项目身份：一个目录属于哪个项目。自动角色的主键（scope + slug）从这里来。
//
// 为什么不直接用 basename(dir)：派发会落在 worktree 里（internal-20261014-d7za 这种名字），
// 会话可能开在仓库的子目录，同一个仓库在 vault 里还被目录名和远程名各记过一份（internal / ownward）。
// 规则：
//   1. 必须是 git 仓库——~/workspace、~ 这种目录不是项目，不配有 Owner
//      （vault 里 workspace/tis/downloads 这些空壳项目就是这么来的，别再给它们配角色）；
//   2. linked worktree 归到主检出（git-common-dir 的上一级）：任务 worktree 和主目录是同一个项目；
//   3. slug = 主检出目录名小写——与 harvest 给派发任务记日志用的 slug 同源（t.project = basename(派发目录)），
//      记忆写在哪、角色就读哪；远程仓库名不同时作为别名（capture 按触达仓库记日志时用的是远程名）。
import { realpathSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, resolve } from "path";
import { scopeForRemote, type Scope } from "./paths.ts";
import { expandHome } from "./util.ts";

export interface ProjectIdentity {
  /** 主检出根目录（realpath）：派发与角色 dirs 都用它 */
  root: string;
  scope: Scope;
  /** vault 里 <scope>/projects/<slug>/ */
  slug: string;
  /** 同一项目在 vault 里可能的其它目录名（远程仓库名），只在 vault 里真有这个目录时才关联 */
  aliases: string[];
  /** 展示名：远程仓库名优先（保留大小写），没有远程用目录名 */
  label: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;   // 与 roles.ts / project-memory.ts 同一条

/** 任意目录名 → 合法 slug。合不出来（全是中文/符号）就空串，调用方当「没有项目身份」 */
export function slugForName(name: string): string {
  const s = String(name || "").trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "").slice(0, 64);
  return SLUG_RE.test(s) ? s : "";
}

/** 远程第一条 URL 的最后一段（同 capture.repoNameOf，但保留大小写给展示用） */
export function remoteRepoName(remoteText: string): string {
  const url = (String(remoteText || "").split("\n")[0] || "").trim().split(/\s+/)[1] || "";
  return (url.replace(/\/+$/, "").split(/[/:]/).pop() || "").replace(/\.git$/, "");
}

/** 先认 HOME 环境变量（launchd 注入、测试改写都走它；Bun 的 homedir() 不跟着 HOME 变），没有才问系统 */
function realHome(): string {
  const home = process.env.HOME || homedir();
  try { return realpathSync(home); } catch { return home; }
}

function git(dir: string, args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
    return r.exitCode === 0 ? new TextDecoder().decode(r.stdout) : null;
  } catch { return null; }
}

// 派发弹窗每改一次目录就问一遍：三次 git 子进程不贵，但没必要每次都起
const cache = new Map<string, { at: number; value: ProjectIdentity | null }>();
const TTL_MS = 5 * 60_000;
export function clearProjectIdentityCache() { cache.clear(); }

/** null = 目录不存在 / 不是 git 仓库 / 目录名合不出 slug。
 *  scopeFor 只给单测注入（生产按 vault.workRemoteMatch 判，测试不许吃运行环境的 config.json） */
export function projectIdentity(dir: string, opts: { scopeFor?: (remoteText: string) => Scope } = {}): ProjectIdentity | null {
  // 空串交给 resolve 会变成进程 cwd——daemon 的 cwd 就是 Ownward 自己的仓库，凭空给它认出一个项目
  const raw = String(dir ?? "").trim();
  if (!raw) return null;
  let real: string;
  try {
    real = realpathSync(resolve(expandHome(raw)));
    if (!statSync(real).isDirectory()) return null;
  } catch { return null; }
  const cacheable = !opts.scopeFor;
  const hit = cacheable ? cache.get(real) : undefined;
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = compute(real, opts.scopeFor ?? scopeForRemote);
  if (cacheable) cache.set(real, { at: Date.now(), value });
  return value;
}

function compute(real: string, scopeFor: (remoteText: string) => Scope): ProjectIdentity | null {
  const out = git(real, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
  if (!out) return null;
  const [top, common] = out.split("\n").map((s) => s.trim());
  if (!top || !isAbsolute(top)) return null;
  // linked worktree 的 common dir 是主检出的 .git；submodule / 自定义 GIT_DIR 不以 .git 结尾，按本仓库根算
  let root = common && isAbsolute(common) && basename(common) === ".git" ? dirname(common) : top;
  try { root = realpathSync(root); } catch { root = top; }
  // home 目录本身是仓库（有人这么管 dotfiles）时，~ 下每个普通目录都会被认成同一个项目——
  // 一个「home Owner」吞掉所有不相干的任务比没有 Owner 更糟，直接当没有项目身份
  if (root === dirname(root) || root === realHome()) return null;
  const slug = slugForName(basename(root));
  if (!slug) return null;
  const remote = git(root, ["remote", "-v"]) ?? "";
  const repoName = remoteRepoName(remote);
  const alias = slugForName(repoName);
  return {
    root, scope: scopeFor(remote), slug,
    aliases: alias && alias !== slug ? [alias] : [],
    label: repoName || basename(root),
  };
}
