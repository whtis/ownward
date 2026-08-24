import { RunnerServer, type RunnerProviderResolver } from "./server.ts";
import { resolve } from "path";
import { ClaudeCodeRunnerProvider } from "../providers/claude-code/adapter.ts";
import { CodexRunnerProvider } from "../providers/codex/adapter.ts";
import { cfg } from "../util.ts";
import { emitCoreLog } from "../kernel/observability/contracts.ts";

const dataRoot = resolve(process.env.OWNWARD_DATA_ROOT || "data");
if (process.env.OWNWARD_RUNNER_ALLOW_FAKE === "1") throw new Error("生产 Runner 拒绝启用 Fake Provider");
const command=(id:"claude-code"|"codex"|"codebuddy",fallback:string):string[]=>{const value=cfg.providers?.[id]?.command;if(!Array.isArray(value)||!value.length||value.some((part:unknown)=>typeof part!=="string"||!part))return[fallback];return[...value];};
const providers=new Map<string,ClaudeCodeRunnerProvider|CodexRunnerProvider>();
if(cfg.providers?.["claude-code"]?.enabled!==false){const provider=new ClaudeCodeRunnerProvider(command("claude-code","claude"),process.env,{dataRoot});providers.set(provider.id,provider);}
if(cfg.providers?.codex?.enabled!==false){const provider=new CodexRunnerProvider(command("codex","codex"),process.env,{dataRoot});providers.set(provider.id,provider);}
// CodeBuddy（腾讯）：CLI 是 Claude Code 协议克隆，复用同一 adapter 换命令即可。
// opt-in（enabled===true 才启）：默认装机没有这个 CLI，别让 resolver 报「未注册」变成常态
if(cfg.providers?.codebuddy?.enabled===true){const provider=new ClaudeCodeRunnerProvider(command("codebuddy","codebuddy"),process.env,{dataRoot,providerId:"codebuddy"});providers.set(provider.id,provider);}
const resolver: RunnerProviderResolver = (providerId) => {
  const provider=providers.get(providerId);if(provider)return provider;
  throw new Error(`Provider 未注册: ${providerId}`);
};
const server = new RunnerServer(dataRoot, resolver);for(const provider of providers.values())server.registerProvider(provider);server.start();
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { if (shuttingDown) return; shuttingDown = true; void server.shutdown(5_000).then(() => process.exit(0), (error) => { emitCoreLog({ event: "runner-shutdown-failed", moduleType: "runner", moduleId: "session-runner", operation: "shutdown", errorClass: (error as any)?.code || "UNKNOWN", msg: "runner shutdown failed" }); process.exit(1); }); });
emitCoreLog({event:"runner-ready",moduleType:"runner",moduleId:"session-runner",operation:"start",msg:`pid=${process.pid}`},console.log);
