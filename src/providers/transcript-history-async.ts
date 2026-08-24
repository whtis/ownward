import type { RunnerHistoryMessage } from "../runner/server.ts";

type Job = { kind: "claude"; nativeRef: string; home?: string }
  | { kind: "codex"; nativeRef: string; providerHome?: string; home?: string };

const MAX_WORKERS = 2;
const WORKER_TIMEOUT_MS = 15_000;
let active = 0;
const waiting: Array<() => void> = [];
let workerFactory=()=>new Worker(new URL("./transcript-history-worker.ts", import.meta.url).href,{type:"module"});
export function setTranscriptHistoryWorkerFactoryForTest(factory:(()=>Worker)|null){workerFactory=factory??(()=>new Worker(new URL("./transcript-history-worker.ts",import.meta.url).href,{type:"module"}));}

async function permit(): Promise<() => void> {
  while (active >= MAX_WORKERS) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  return () => { active--; waiting.shift()?.(); };
}

async function run(job: Job): Promise<RunnerHistoryMessage[]> {
  const release = await permit();
  const id = crypto.randomUUID();
  let worker:Worker|undefined;
  try {
    worker = workerFactory();
    return await new Promise<RunnerHistoryMessage[]>((resolve, reject) => {
      const timer = setTimeout(() => { worker.terminate(); reject(Object.assign(new Error("历史 Worker 超时"), { code: "RUNNER_HISTORY_TIMEOUT" })); }, WORKER_TIMEOUT_MS);
      worker.onmessage = (event: MessageEvent<any>) => {
        if (event.data?.id !== id) return;
        clearTimeout(timer); event.data.ok ? resolve(event.data.messages) : reject(new Error(event.data.message || "历史读取失败"));
      };
      worker.onerror = (event: ErrorEvent) => { clearTimeout(timer); reject(new Error(event.message || "历史 Worker 失败")); };
      worker.postMessage({ id, ...job });
    });
  } finally { worker?.terminate(); release(); }
}

export const readClaudeTranscriptAsync = (nativeRef: string, home?: string) => run({ kind: "claude", nativeRef, ...(home ? { home } : {}) });
export const readCodexTranscriptAsync = (nativeRef: string, providerHome?: string, home?: string) => run({ kind: "codex", nativeRef, ...(providerHome ? { providerHome } : {}), ...(home ? { home } : {}) });
