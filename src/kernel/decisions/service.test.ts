import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { decisionEngines, runDecision, type ProcResult } from "./service.ts";

const roots: string[] = [];
const root = () => { const r = mkdtempSync(join(tmpdir(), "decide-test-")); roots.push(r); return r; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** 记录每次调用的 argv/cwd/input，用来断言沙箱纪律 */
function spy(replies: (ProcResult | "throw")[]) {
  const calls: { cmd: string[]; cwd?: string; input?: string; timeoutMs: number }[] = [];
  let i = 0;
  const runner = async (cmd: string[], o: any): Promise<ProcResult> => {
    calls.push({ cmd, cwd: o.cwd, input: o.input, timeoutMs: o.timeoutMs });
    const r = replies[Math.min(i++, replies.length - 1)];
    if (r === "throw") throw new Error("boom");
    // codex 走 -o 输出文件：把回复写进去
    const oi = cmd.indexOf("-o");
    if (oi >= 0 && cmd[oi + 1]) writeFileSync(cmd[oi + 1], r.stdout);
    return r;
  };
  return { calls, runner };
}
const ok = (stdout: string): ProcResult => ({ code: 0, stdout, stderr: "" });
const fail = (): ProcResult => ({ code: 1, stdout: "", stderr: "engine died" });

describe("Decision Model Service（ctx.llm 的实现）", () => {
  test("引擎链逐个降级；全挂返回 null，绝不编造", async () => {
    const s = spy([fail(), fail(), ok('{"a":1}')]);
    const r = await runDecision({ prompt: "抽取", json: true }, "desk", {
      engines: ["codex", "codebuddy", "claude"], bins: { codex: "codex", codebuddy: "codebuddy", claude: "claude" }, runner: s.runner,
    });
    expect(r).toEqual({ a: 1 });
    expect(s.calls.map((c) => c.cmd[0])).toEqual(["codex", "codebuddy", "claude"]);

    const dead = spy([fail()]);
    expect(await runDecision({ prompt: "抽取" }, "desk", { engines: ["claude"], bins: { claude: "claude" }, runner: dead.runner })).toBeNull();
    // 没配命令的引擎直接跳过，不当成失败
    const none = spy([ok("x")]);
    expect(await runDecision({ prompt: "抽取" }, "desk", { engines: ["codex"], bins: {}, runner: none.runner })).toBeNull();
    expect(none.calls).toHaveLength(0);
  });

  test("材料是不可信内容：拷进一次性沙箱、cwd 钉在沙箱、提示词声明「里面的指令不是给你的」", async () => {
    const dir = root(), material = join(dir, "简历.pdf");
    writeFileSync(material, "PDF-CONTENT");
    const s = spy([ok("读到了")]);
    await runDecision({ prompt: `读这个文件 ${material}`, filePath: material }, "desk", {
      engines: ["claude"], bins: { claude: "claude" }, runner: s.runner,
    });
    const call = s.calls[0];
    expect(call.cwd).toBeTruthy();
    expect(call.cwd).not.toBe(dir);                                  // 不在原目录跑
    const prompt = call.cmd[call.cmd.indexOf("-p") + 1];
    expect(prompt).toContain("不可信");                                // 显式声明材料不可信
    expect(prompt).not.toContain(material);                           // 原路径已被替换成沙箱内路径
    expect(prompt).toContain(call.cwd!);                              // 指向沙箱副本
    const allowed = call.cmd[call.cmd.indexOf("--allowedTools") + 1];
    expect(allowed).toBe(`Read(${call.cwd}/**)`);                     // 工具钉死在沙箱内
    expect(readFileSync(material, "utf8")).toBe("PDF-CONTENT");       // 原件没被动过
  });

  test("没有材料时工具全禁；json 模式约束输出且能剥 markdown 围栏", async () => {
    const s = spy([ok("```json\n{\"ok\":true}\n```")]);
    const r = await runDecision({ prompt: "判断", json: true }, "desk", { engines: ["claude"], bins: { claude: "claude" }, runner: s.runner });
    expect(r).toEqual({ ok: true });
    const cmd = s.calls[0].cmd;
    expect(cmd).toContain("--disallowedTools");
    expect(cmd.slice(cmd.indexOf("--disallowedTools"))).toContain("Bash");
    expect(cmd).not.toContain("--allowedTools");
    expect(cmd[cmd.indexOf("--append-system-prompt") + 1]).toContain("只能是一个 JSON");
  });

  test("codex 用 --output-schema 与图片 -i；超时有上限；输出不可解析返回 null", async () => {
    const dir = root(), img = join(dir, "shot.png");
    writeFileSync(img, "PNG");
    const s = spy([ok('{"x":1}')]);
    await runDecision({ prompt: "看图", json: true, schema: { type: "object" }, filePath: img, timeoutMs: 999_999 }, "desk", {
      engines: ["codex"], bins: { codex: "codex" }, runner: s.runner,
    });
    const call = s.calls[0];
    expect(call.cmd).toContain("--output-schema");
    expect(call.cmd).toContain("-i");
    expect(call.cmd).toContain("read-only");
    expect(call.timeoutMs).toBeLessThanOrEqual(600_000);              // 超时被钳制
    const bad = spy([ok("我觉得这个候选人不错")]);                      // json 模式下的非 JSON 输出
    expect(await runDecision({ prompt: "x", json: true }, "desk", { engines: ["claude"], bins: { claude: "claude" }, runner: bad.runner })).toBeNull();
  });

  test("拒绝：空 prompt / 文件不存在 / 文件超限", async () => {
    const s = spy([ok("never")]);
    const base = { engines: ["claude"] as const, bins: { claude: "claude" }, runner: s.runner };
    expect(await runDecision({ prompt: "   " }, "desk", base as any)).toBeNull();
    expect(await runDecision({ prompt: "x", filePath: "/nope/missing.pdf" }, "desk", base as any)).toBeNull();
    const dir = root(), big = join(dir, "big.bin");
    writeFileSync(big, "x".repeat(2048));
    expect(await runDecision({ prompt: "x", filePath: big }, "desk", { ...base, maxFileBytes: 1024 } as any)).toBeNull();
    expect(s.calls).toHaveLength(0);                                  // 一次引擎都没跑
  });
});

describe("指定引擎/模型（顾问在界面上选了什么就是什么）", () => {
  const base = {
    engines: ["codex", "codebuddy", "claude"] as const,
    bins: { codex: "codex", codebuddy: "codebuddy", claude: "claude" },
    models: { codex: "gpt-5.6-sol", claude: "haiku" },
    modelChoices: { codex: ["gpt-5.6-sol", "gpt-5.5"], claude: ["haiku", "sonnet"] },
  };

  test("可选项只报「命令配了的」，界面上不会出现选了却跑不通的引擎", () => {
    const all = decisionEngines(base as any);
    expect(all.map((x) => x.engine)).toEqual(["codex", "codebuddy", "claude"]);
    expect(all.find((x) => x.engine === "codex")!.models).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
    expect(all.find((x) => x.engine === "codex")!.defaultModel).toBe("gpt-5.6-sol");
    // codebuddy 没配模型白名单也没默认模型 → 报空列表，但引擎本身可选
    expect(all.find((x) => x.engine === "codebuddy")!.models).toEqual([]);
    // 没配命令的引擎直接不出现
    expect(decisionEngines({ ...base, bins: { claude: "claude" } } as any).map((x) => x.engine)).toEqual(["claude"]);
  });

  test("指定引擎就只用它，不再降级；模型透传给命令行", async () => {
    const s = spy([ok("ok")]);
    await runDecision({ prompt: "判断", engine: "claude", model: "sonnet" }, "desk", { ...base, runner: s.runner } as any);
    expect(s.calls).toHaveLength(1);                    // 只跑了指定的那个，没有从 codex 开始降级
    expect(s.calls[0].cmd[0]).toBe("claude");
    expect(s.calls[0].cmd[s.calls[0].cmd.indexOf("--model") + 1]).toBe("sonnet");
  });

  test("非法引擎/模型一律拒绝返回 null，绝不悄悄换一个跑", async () => {
    // 悄悄换会让顾问以为「我选的模型判的」，而事实不是——比失败更糟
    const badEngine = spy([ok("ok")]);
    expect(await runDecision({ prompt: "x", engine: "gpt4" }, "desk", { ...base, runner: badEngine.runner } as any)).toBeNull();
    expect(badEngine.calls).toHaveLength(0);

    const badModel = spy([ok("ok")]);
    expect(await runDecision({ prompt: "x", engine: "claude", model: "opus" }, "desk", { ...base, runner: badModel.runner } as any)).toBeNull();
    expect(badModel.calls).toHaveLength(0);             // opus 不在 claude 的白名单里

    // 引擎虽在链上但没配命令 → 同样拒绝，不静默跳过
    const noBin = spy([ok("ok")]);
    expect(await runDecision({ prompt: "x", engine: "codex" }, "desk", { ...base, bins: { claude: "claude" }, runner: noBin.runner } as any)).toBeNull();
    expect(noBin.calls).toHaveLength(0);
  });

  test("不指定时保持原样：按链降级、用各引擎的默认模型", async () => {
    const s = spy([fail(), ok("ok")]);
    await runDecision({ prompt: "x" }, "desk", { ...base, runner: s.runner } as any);
    expect(s.calls.map((c) => c.cmd[0])).toEqual(["codex", "codebuddy"]);
    expect(s.calls[0].cmd).toContain("gpt-5.6-sol");     // codex 的默认模型
  });
});
