// 路径包含判断：target 是不是在 root 之内。
//
// 本仓早期的边界检查统一写成 `p.startsWith(root + "/")`。POSIX 上没问题，
// Windows 上分隔符是 `\`，于是 `C:\a\b`.startsWith(`C:\a` + "/") 恒为 false——
// 所有子路径都被判成越界。表现是：目录选择器能列出仓库，但一个都选不中
// （"目录不在授权范围（architecture.allowedRoots）内"），派发任务、vault 笔记、
// 项目记忆、roles 全部卡死。方向上是 fail closed，安全，但功能没了。
//
// kernel/extensions/runtime.ts 里的新代码已经用 `sep` 写对了，这里把老代码统一过来。
// 注意大小写：NTFS 不区分大小写，但 realpathSync 会给出规范化后的大小写，
// 所以这里保持逐字比较，不引入 POSIX 上会放宽语义的大小写折叠。
import { sep } from "path";

/** target 在 root 之内，或就是 root 本身。 */
export function isWithin(root: string, target: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** target 严格在 root 之内（等于 root 不算）。 */
export function isStrictlyWithin(root: string, target: string): boolean {
  return target !== root && isWithin(root, target);
}
