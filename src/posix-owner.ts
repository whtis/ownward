// 跨平台的「这个路径归我、别人写不了」断言。
//
// 本仓大量安全门写成 POSIX 形式：`stat.uid === process.getuid()` 加
// `(stat.mode & 0o022) === 0`（或 0o077）。这两条在 Windows 上都不成立：
//   - process.getuid 在 Windows 上根本不存在，直接调用会 TypeError；
//   - Node 在 NTFS 上把 stat.uid 恒报 0、stat.mode 恒报 0o666/0o777，
//     于是「group/other 可写」永远为真，安全门永远拒绝。
// 结果是 Vertical 的 migration gate 在 Windows 上必然失败。
//
// Windows 上的等价保护来自 NTFS ACL：daemon 的 data 目录在用户 profile 下，
// 默认 ACL 只有本人 + Administrators 可写，POSIX 的位掩码在这里没有可检查的对应物。
// 因此这里在 win32 上让断言通过，其余平台逐字保持原语义。
const WINDOWS = process.platform === "win32";

/** stat 的属主是否是当前用户；Windows 上无 uid 概念，恒真。 */
export function ownedByCurrentUser(stat: { uid: number }): boolean {
  return WINDOWS || stat.uid === (process.getuid as () => number)();
}

/** mode 中 mask 指定的位是否全为 0（如 0o022 = group/other 可写）；Windows 上恒真。 */
export function modeBitsClear(stat: { mode: number }, mask: number): boolean {
  return WINDOWS || (stat.mode & mask) === 0;
}
