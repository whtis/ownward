// 决策引擎封装：一次推理 → 严格 JSON。
// engine=claude（默认）：claude -p，吃 Claude 订阅；engine=codex：codex exec，吃 ChatGPT 订阅。
// 规则上下文（prompts/）通过 system prompt 显式注入，不依赖 CLI 的文件发现：
//   prompts/owner.md（gitignored，install.sh 生成的个人画像）+ prompts/decision-rules.md（通用规则）。
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CONFIG_ROOT, ROOT, cfg, log, run } from "./util.ts";

const rules = () => {
  let owner = "";
  try { owner = readFileSync(join(CONFIG_ROOT, "prompts", "owner.md"), "utf8").trim(); } catch { /* 没配就纯规则 */ }
  const base = readFileSync(join(ROOT, "prompts", "decision-rules.md"), "utf8");
  return owner ? `${owner}\n\n${base}` : base;
};

export async function llmJson(prompt: string): Promise<any | null> {
  const engine = cfg.llm?.engine || "claude";
  const r = engine === "codex" ? await viaCodex(prompt) : await viaClaude(prompt);
  return r;
}

async function viaClaude(prompt: string): Promise<any | null> {
  const args = [
    "-p", prompt,
    "--model", cfg.llm?.claudeModel || "haiku",
    "--max-turns", "3",            // 留一点余量；工具已全禁，正常一轮就出结果
    "--disallowedTools", "Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit",
    "--output-format", "text",
    "--append-system-prompt",
    rules() + "\n\n不要使用任何工具。最终回复必须是且只能是一个 JSON 对象，不要 markdown 代码块，不要任何解释文字。",
  ];
  const r = await run([cfg.llm?.claudeBin || "claude", ...args], {
    timeoutMs: 180_000,
    cwd: ROOT,
    env: { DISABLE_OMC: "1" },     // 关掉用户级 OMC hooks，避免注入编排指令
  });
  if (r.code !== 0) {
    log(`claude -p failed (${r.code}): ${(r.stderr || r.stdout).slice(-300)}`);
    return null;
  }
  return parseJson(r.stdout);
}

async function viaCodex(prompt: string): Promise<any | null> {
  const dir = mkdtempSync(join(tmpdir(), "ownward-llm-"));
  const outFile = join(dir, "last.txt");
  const args = [
    "exec", "--sandbox", "read-only", "--skip-git-repo-check",
    "-C", ROOT, "--output-last-message", outFile,
  ];
  if (cfg.llm?.codexModel) args.push("-m", cfg.llm.codexModel);
  args.push(prompt);
  try {
    const r = await run([cfg.llm?.codexBin || "codex", ...args], { timeoutMs: 180_000 });
    if (r.code !== 0) {
      log(`codex exec failed (${r.code}): ${r.stderr.slice(-300)}`);
      return null;
    }
    let text = "";
    try { text = readFileSync(outFile, "utf8"); } catch { text = r.stdout; }
    return parseJson(text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseJson(text: string): any | null {
  const stripped = text.replace(/```(?:json)?/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) {
    log(`llm output not JSON: ${stripped.slice(0, 200)}`);
    return null;
  }
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch (e) {
    log(`llm JSON parse error: ${e}`);
    return null;
  }
}
