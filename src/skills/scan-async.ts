import type { SkillScanOptions } from "./contracts.ts";
import type { RawSkillSnapshot } from "./internal.ts";

export function scanSkillsAsync(options: SkillScanOptions): Promise<RawSkillSnapshot> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./scan-worker.ts", import.meta.url).href);
    const finish = () => { try { worker.terminate(); } catch {} };
    worker.onmessage = (event) => { finish(); const value = event.data; if (value?.ok) resolve(value.snapshot); else reject(Object.assign(new Error(value?.error?.message || "Skill scan worker failed"), { code: value?.error?.code || "SKILL_SCAN_FAILED" })); };
    worker.onerror = (event) => { finish(); reject(Object.assign(new Error(event.message || "Skill scan worker crashed"), { code: "SKILL_SCAN_WORKER_FAILED" })); };
    worker.postMessage(options);
  });
}
