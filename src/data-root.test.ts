// 数据根路径的静态防线：daemon 生产态运行在 data/releases/<hash>/ 快照里，
// ROOT（模块位置推导）指向快照——`join(ROOT, "data")` 会把状态写进/读自快照目录。
// 2026-08-20 实锤过的一整类事故：api-token 每次发布重新生成（远程登录随发布失效）、
// feed 的 SSE watch 盯着不存在的目录、自定义皮肤随发布"消失"、projects/lark-names 读错。
// 数据一律走 util.DATA（OWNWARD_DATA_ROOT env 驱动）；ROOT 只许用于快照内资产（web/、prompts/）。
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules") out.push(...tsFiles(p)); continue; }
    if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("数据路径不许从 ROOT 派生", () => {
  test('src/ 生产代码禁止 join(ROOT, "data")', () => {
    const offenders = tsFiles(join(import.meta.dir))
      .filter((f) => /join\(\s*ROOT\s*,\s*["']data["']/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(import.meta.dir.length + 1));
    expect(offenders).toEqual([]);
  });
});
