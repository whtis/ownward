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
import { fsyncSync as nodeFsyncSync } from "fs";

const WINDOWS = process.platform === "win32";

export function fsyncSync(fd: number): void {
  try {
    nodeFsyncSync(fd);
  } catch (error) {
    if (WINDOWS && (error as NodeJS.ErrnoException)?.code === "EPERM") return;
    throw error;
  }
}
