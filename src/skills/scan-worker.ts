import { scanSkillsRaw } from "./scanner.ts";
import type { SkillScanOptions } from "./contracts.ts";

declare const self: Worker;
self.onmessage = (event: MessageEvent<SkillScanOptions>) => {
  try { self.postMessage({ ok: true, snapshot: scanSkillsRaw(event.data) }); }
  catch (error) { self.postMessage({ ok: false, error: { message: error instanceof Error ? error.message : String(error), code: (error as any)?.code || "SKILL_SCAN_FAILED" } }); }
};
