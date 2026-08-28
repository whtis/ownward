import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { DATA, SOURCE_ROOT, ensureDir, run } from "./util.ts";
import { writeRestartIntent } from "./restart.ts";

export type DeployAction = "restart" | "apply" | "rollback" | "settings-apply" | "settings-recover";

export function helperLabel(id: string): string {
  const safe = id.toLowerCase().replace(/[^a-z0-9.-]/g, "-").replace(/-+/g, "-").slice(0, 48);
  if (!safe) throw new Error("invalid deploy helper id");
  return `ai.ownward.deploy.${safe}`;
}

if (import.meta.main && process.argv[2] === "--write-intent") {
  try {
    const intent = writeRestartIntent(DATA, process.argv[3] || "deploy-helper");
    console.log(`${intent.expectedGeneration}:${intent.expectedPid}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

export function renderHelperPlist(label: string, root: string, action: DeployAction, args: string[], logFile: string,
  bunPath = process.execPath): string {
  const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  // PATH 必须带上用户级 bin：claude/codex 装在 ~/.local/bin，缺了它 provider canary
  // 会一直「CLI not installed」被跳过——发布门形同虚设（2026-08-20 两次发布实证）
  const home = process.env.HOME || "";
  const path = [dirname(bunPath), ...(home ? [`${home}/.local/bin`, `${home}/.bun/bin`] : []), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    .filter((v, i, all) => all.indexOf(v) === i).join(":");
  const argv = ["/bin/bash", join(root, "scripts", "deploy-helper.sh"), action, ...args]
    .map((v) => `    <string>${esc(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${esc(label)}</string>\n  <key>ProgramArguments</key><array>\n${argv}\n  </array>\n  <key>WorkingDirectory</key><string>${esc(root)}</string>\n  <key>EnvironmentVariables</key><dict>\n    <key>OWNWARD_BUN</key><string>${esc(bunPath)}</string>\n    <key>PATH</key><string>${esc(path)}</string>\n  </dict>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><false/>\n  <key>ProcessType</key><string>Background</string>\n  <key>StandardOutPath</key><string>${esc(logFile)}</string>\n  <key>StandardErrorPath</key><string>${esc(logFile)}</string>\n</dict></plist>\n`;
}

/** bootstrap 返回成功才算确定性派发；helper 是 launchd 的独立 job，不是 daemon 子进程。 */
export async function dispatchDeployHelper(action: DeployAction, args: string[] = [], id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`): Promise<string> {
  ensureDir(DATA);
  mkdirSync(join(DATA, "deploy"), { recursive: true });
  mkdirSync(join(DATA, "logs"), { recursive: true });
  const label = helperLabel(id);
  const plist = join(DATA, "deploy", `${label}.plist`);
  const logFile = join(DATA, "logs", `${label}.log`);
  writeFileSync(plist, renderHelperPlist(label, SOURCE_ROOT, action, args, logFile, process.execPath), { mode: 0o600 });
  chmodSync(plist, 0o600);
  const r = await run(["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 0}`, plist], { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(`部署 helper 派发失败 (${label}): ${r.stderr.slice(0, 240)}`);
  return label;
}
