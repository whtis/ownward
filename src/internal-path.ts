import { isAbsolute, relative, resolve, sep } from "path";

/** cwd 是否位于 Ownward 的运行时 data 目录内（同前缀兄弟目录不算）。 */
export function isWithinDataDir(cwd: string, dataDir: string): boolean {
  const rel = relative(resolve(dataDir), resolve(cwd));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
