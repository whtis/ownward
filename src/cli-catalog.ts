// Claude Code / CodeBuddy 的模型与思考深度目录：两家 CLI 没有像 codex 那样的模型缓存文件，但 `--help` 就是官方声明——
// CodeBuddy 在 `--model` 一行直接列出「Currently supported: (…)」，两家都在 `--effort` 一行列出合法档位。
// 这里跑一次 `<cli> --help` 解析出来（内存缓存 6 小时，探测失败或超时回退内置快照），Ownward 不再手写型号表：
// 2026-09-05 发现手写的 CodeBuddy 表已经全部过期（kimi-k3-1 / minimax-m3 / deepseek-v3-2-volc 早已下线）。
// Claude Code 的 `--help` 只说「alias 或全名」，型号列表来自内置别名 + ~/.claude.json 里服务端下发的
// additionalModelOptionsCache（/model 菜单里「额外」的型号，如 Fable）。
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface CliHelpProbe { ok: boolean; efforts: string[]; models: string[]; reason?: string; at: number }
const HELP_TTL_MS = 6 * 60 * 60 * 1000;
const HELP_TIMEOUT_MS = 15_000;
const helpCache = new Map<string, CliHelpProbe>();

/** 从 help 文本里取 `--effort <level>` 选项说明括号内的档位；取不到返回空数组（调用方决定兜底）。
 *  claude 的说明会折行（档位列表在下一行），所以把该选项到下一个选项之间的续行一起看 */
export function parseHelpEfforts(help: string): string[] {
  const lines = help.split("\n"), start = lines.findIndex((l) => /^\s*--effort\s+<level>/.test(l));
  if (start < 0) return [];
  let block = lines[start];
  for (let i = start + 1; i < lines.length && !/^\s*-{1,2}[A-Za-z]/.test(lines[i]) && lines[i].trim(); i++) block += " " + lines[i].trim();
  const m = block.match(/\(([^)]+)\)/);
  return m ? m[1].split(",").map((s) => s.trim()).filter((s) => /^[a-z]+$/.test(s)) : [];
}
/** CodeBuddy 的 `--model` 行：「Currently supported: (hy3, glm-5.3, …)」 */
export function parseHelpModels(help: string): string[] {
  const start = help.search(/^\s*--model\s+<model>/m);
  if (start < 0) return [];
  const m = help.slice(start, start + 2000).match(/Currently supported:\s*\(([^)]+)\)/);
  return m ? [...new Set(m[1].split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(s)))] : [];
}

/** 跑 `<cli> --help`（异步、有界超时、永不抛——daemon 的事件循环不能被 node 启动的一秒卡住）；同一命令 6 小时内复用，
 *  并发调用共用同一次探测。exec 失败/超时/没解析出东西都算失败并带原因 */
const inflight = new Map<string, Promise<CliHelpProbe>>();
export function probeCliHelp(command: readonly string[], options: { now?: number; env?: Record<string, string | undefined>; force?: boolean } = {}): Promise<CliHelpProbe> {
  const key = command.join(" "), now = options.now ?? Date.now(), hit = helpCache.get(key);
  if (hit && !options.force && now - hit.at < HELP_TTL_MS) return Promise.resolve(hit);
  const running = inflight.get(key); if (running && !options.force) return running;
  const task = (async (): Promise<CliHelpProbe> => {
    let probe: CliHelpProbe;
    try {
      if (!command.length || !command[0]) throw new Error("命令为空");
      const proc = Bun.spawn([...command, "--help"], { env: { ...(options.env ?? process.env), DISABLE_OMC: "1" }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, HELP_TIMEOUT_MS);
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout as ReadableStream<Uint8Array>).text(), new Response(proc.stderr as ReadableStream<Uint8Array>).text(), proc.exited]).finally(() => clearTimeout(timer));
      const text = `${stdout}\n${stderr}`;
      if (code !== 0 && !text.includes("--help")) throw new Error(`退出码 ${code}`);
      const efforts = parseHelpEfforts(text), models = parseHelpModels(text);
      if (!efforts.length && !models.length) throw new Error("help 里没有可解析的 --effort / --model 声明");
      probe = { ok: true, efforts, models, at: now };
    } catch (error) {
      probe = { ok: false, efforts: [], models: [], reason: error instanceof Error ? error.message : String(error), at: now };
    }
    helpCache.set(key, probe);
    return probe;
  })().finally(() => { if (inflight.get(key) === task) inflight.delete(key); });
  inflight.set(key, task);
  return task;
}
export function resetCliHelpCache(): void { helpCache.clear(); inflight.clear(); }

export interface ClaudeAdditionalModel { value: string; label: string; description: string }
/** ~/.claude.json 的 additionalModelOptionsCache：服务端按账号下发的额外型号（/model 菜单里内置四项之外的那些） */
export function claudeAdditionalModels(file = join(process.env.HOME || homedir(), ".claude.json")): ClaudeAdditionalModel[] {
  try {
    if (!existsSync(file)) return [];
    const raw = JSON.parse(readFileSync(file, "utf8")) as { additionalModelOptionsCache?: unknown };
    const list = Array.isArray(raw.additionalModelOptionsCache) ? raw.additionalModelOptionsCache : [];
    return list.flatMap((item: any) => typeof item?.value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,127}$/.test(item.value)
      ? [{ value: item.value, label: typeof item.label === "string" ? item.label : item.value, description: typeof item.description === "string" ? item.description : "" }]
      : []);
  } catch { return []; }
}
