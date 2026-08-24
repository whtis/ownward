// 浏览器内目录选择的服务端：只允许列 architecture.allowedRoots 圈内的目录。
// 为什么不用本机 Finder（旧 /api/pick-dir 的 osascript choose folder）：远程打开 web 时
// 弹窗出现在 daemon 那台机器的屏幕上，浏览器这边只会挂死到超时——目录选择必须发生在浏览器里。
// 安全边界：realpath 归一化后前缀匹配（symlink/`..` 逃逸一律拒绝），符号链接子目录不列
// （withFileTypes 的 isDirectory 对 symlink 为 false），隐藏目录不列，条数有界且截断可见。
import { isWithin } from "./path-within.ts";
import { existsSync, readdirSync, realpathSync } from "fs";
import { dirname, join, resolve } from "path";

export interface DirEntry { name: string; path: string; git: boolean; }
export interface DirListing { ok: true; path: string | null; parent: string | null; entries: DirEntry[]; truncated: boolean; }
export type DirBrowseResult = DirListing | { ok: false; msg: string };

export function listDirs(rawPath: string | null | undefined, allowedRoots: readonly unknown[], cap = 300): DirBrowseResult {
  const roots: string[] = [];
  for (const r of allowedRoots) {
    if (typeof r !== "string" || !r.trim()) continue;
    try { const real = realpathSync(resolve(r)); if (!roots.includes(real)) roots.push(real); } catch { /* 配置里已消失的根跳过 */ }
  }
  if (!roots.length) return { ok: false, msg: "未配置 architecture.allowedRoots，无可浏览目录" };
  // 无 path：返回授权根列表（选择器的顶层视图）
  if (!rawPath) return { ok: true, path: null, parent: null, entries: roots.map((p) => ({ name: p, path: p, git: existsSync(join(p, ".git")) })), truncated: false };
  let real: string;
  try { real = realpathSync(resolve(String(rawPath))); } catch { return { ok: false, msg: "目录不存在或不可访问" }; }
  const root = roots.find((r) => isWithin(r, real));
  if (!root) return { ok: false, msg: "目录不在授权范围（architecture.allowedRoots）内" };
  let names: string[];
  try {
    names = readdirSync(real, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
  } catch { return { ok: false, msg: "目录不可读" }; }
  const truncated = names.length > cap;
  const entries = names.slice(0, cap).map((name) => { const p = join(real, name); return { name, path: p, git: existsSync(join(p, ".git")) }; });
  const parent = real === root ? null : dirname(real);
  return { ok: true, path: real, parent, entries, truncated };
}
