// 全局数据版本闸：它必须先于 daemon 的任何 DATA 写入运行。
// 当前台阶只建立闸门，不迁移业务数据；schema 1 就是现有磁盘格式的基线。
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";

export const SUPPORTED_SCHEMA_VERSION = 1;
// 无 schema gate 的历史版本只认识最初磁盘格式；这个回滚上限不得随当前支持版本提升。
export const LEGACY_ROLLBACK_SCHEMA_VERSION = 1;

export interface DataSchema {
  version: number;
  applied: string[];
}

export class SchemaCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaCompatibilityError";
  }
}

export function schemaFile(dataRoot: string): string {
  return join(dataRoot, "schema.json");
}

/** 只读兼容性检查。缺文件表示尚未建立版本闸的 legacy 数据，按 schema 1 读取。 */
export function readCompatibleSchema(dataRoot: string): DataSchema | null {
  const file = schemaFile(dataRoot);
  if (!existsSync(file)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new SchemaCompatibilityError(`data/schema.json 无法读取或不是合法 JSON：${e}`);
  }
  if (!parsed || typeof parsed !== "object" || !Number.isInteger((parsed as any).version)) {
    throw new SchemaCompatibilityError("data/schema.json 缺少整数 version");
  }
  const version = (parsed as any).version as number;
  if (version < 1) throw new SchemaCompatibilityError(`不支持的数据 schema ${version}`);
  if (version > SUPPORTED_SCHEMA_VERSION) {
    throw new SchemaCompatibilityError(
      `数据 schema ${version} 高于当前程序支持的 ${SUPPORTED_SCHEMA_VERSION}，拒绝启动以避免旧代码写坏新数据`,
    );
  }
  const applied = (parsed as any).applied;
  if (applied !== undefined && (!Array.isArray(applied) || applied.some((x) => typeof x !== "string"))) {
    throw new SchemaCompatibilityError("data/schema.json 的 applied 必须是字符串数组");
  }
  return { version, applied: applied ?? [] };
}

/** 给“目标版本不含 gate”的回滚专用：永久只接受 missing/schema 1，与当前支持上限无关。 */
export function assertLegacyRollbackCompatible(dataRoot: string): void {
  const file = schemaFile(dataRoot);
  if (!existsSync(file)) return;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { throw new SchemaCompatibilityError(`legacy 回滚拒绝损坏的 data/schema.json：${e}`); }
  if (!parsed || typeof parsed !== "object" || !Number.isInteger((parsed as any).version)) {
    throw new SchemaCompatibilityError("legacy 回滚要求 data/schema.json 含整数 version");
  }
  const version = (parsed as any).version as number;
  if (version !== LEGACY_ROLLBACK_SCHEMA_VERSION) {
    throw new SchemaCompatibilityError(
      `无 schema gate 的旧版本只支持 legacy schema ${LEGACY_ROLLBACK_SCHEMA_VERSION}，当前是 ${version}`,
    );
  }
  const applied = (parsed as any).applied;
  if (applied !== undefined && (!Array.isArray(applied) || applied.some((x) => typeof x !== "string"))) {
    throw new SchemaCompatibilityError("legacy 回滚拒绝 applied 非字符串数组的 schema");
  }
}

/** 兼容性确认后幂等建立 schema 1；同目录临时文件 + 独占发布，避免半截 JSON 和并发覆盖。 */
export function ensureCompatibleSchema(dataRoot: string): DataSchema {
  const existing = readCompatibleSchema(dataRoot);
  if (existing) return existing;

  mkdirSync(dataRoot, { recursive: true });
  const initial: DataSchema = { version: SUPPORTED_SCHEMA_VERSION, applied: [] };
  const tmp = join(dataRoot, `.schema.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(initial, null, 2) + "\n", { flag: "wx" });
    // hard-link 是不覆盖的原子发布：若并发进程已经建立 schema，绝不能用旧判断覆盖它。
    try { linkSync(tmp, schemaFile(dataRoot)); }
    catch (e: any) { if (e?.code !== "EEXIST") throw e; }
  } finally {
    try { rmSync(tmp); } catch { /* rename 成功或临时文件已不存在 */ }
  }
  return readCompatibleSchema(dataRoot)!;
}

// 脚本复用同一个兼容性判断：--check 只读，--ensure 可初始化 legacy 数据。
if (import.meta.main) {
  const mode = process.argv[2];
  const dataRoot = resolve(process.argv[3] || join(import.meta.dir, "..", "..", "data"));
  try {
    if (mode === "--check-legacy") {
      assertLegacyRollbackCompatible(dataRoot);
      console.log(`schema compatible: legacy(${LEGACY_ROLLBACK_SCHEMA_VERSION})`);
      process.exit(0);
    }
    const schema = mode === "--ensure" ? ensureCompatibleSchema(dataRoot) : readCompatibleSchema(dataRoot);
    console.log(`schema compatible: ${schema?.version ?? "legacy(1)"}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(78);
  }
}
