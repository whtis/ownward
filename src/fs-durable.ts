// 跨平台 fsync：Windows 的 FlushFileBuffers 要求句柄自带写权限。
//
// 本仓的持久化写法统一是「写 tmp → fsync 内容 → rename → fsync 父目录」，
// 两处 fsync 都走 `openSync(path, "r")` 拿只读句柄。这在 POSIX 上完全正确，
// 但在 Windows 上两处都会 EPERM：
//   - 只读句柄 fsync           → EPERM（缺 GENERIC_WRITE）
//   - 目录句柄 fsync           → EPERM（Win32 没有目录 flush 语义）
// 结果是 daemon 在 Windows 上开机即死（actions.save 的第一次落盘就抛）。
//
// 这里不改调用方的写序列，只把 fsync 本身做成可移植的：Windows 上把这类
// EPERM 视为「该句柄类型不支持 flush」并跳过。内容本身已经由 writeFileSync /
// writeSync 的写句柄落到文件系统缓存，rename 仍是原子的；失去的只是
// Windows 断电场景下的 durability 保证——POSIX 路径的行为一个字节没变。
import { fsyncSync as nodeFsyncSync, closeSync, openSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";

const WINDOWS = process.platform === "win32";

export function fsyncSync(fd: number): void {
  try {
    nodeFsyncSync(fd);
  } catch (error) {
    if (WINDOWS && (error as NodeJS.ErrnoException)?.code === "EPERM") return;
    throw error;
  }
}

/** 原子落盘：写 tmp → fsync 内容 → rename → fsync 父目录（本仓统一写法）。
 *  直接 writeFileSync 崩在半途会留下截断文件，下次读解析失败→整份数据静默丢失。
 *  调用方目录必须已存在。 */
export function writeFileAtomic(file: string, data: string | Uint8Array, opts: { mode?: number } = {}): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, data, opts.mode !== undefined ? { mode: opts.mode } : undefined);
  const fd = openSync(temp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  const dfd = openSync(dirname(file), "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); }
}
