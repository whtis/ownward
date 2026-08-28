import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { routeSkills } from "./routes.ts";
import { SkillInventoryService } from "./service.ts";

const temps: string[] = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("route requires a scan, then returns the in-memory inventory", async () => {
  const home = mkdtempSync(join(tmpdir(), "ownward-skills-route-")); temps.push(home);
  const path = join(home, ".claude", "skills", "demo"); mkdirSync(path, { recursive: true }); writeFileSync(join(path, "SKILL.md"), "---\nname: demo\n---\n");
  const service = new SkillInventoryService({ home });
  const missing = await routeSkills(new Request("http://local/api/skills"), new URL("http://local/api/skills"), service);
  expect(missing?.status).toBe(404);
  const scanned = await routeSkills(new Request("http://local/api/skills/scan", { method: "POST" }), new URL("http://local/api/skills/scan"), service);
  expect(scanned?.status).toBe(200);
  const current = await routeSkills(new Request("http://local/api/skills"), new URL("http://local/api/skills"), service);
  expect(((await current?.json()) as { summary: { total: number } }).summary.total).toBe(1);
});

test("service coalesces concurrent scans", async () => {
  const home = mkdtempSync(join(tmpdir(), "ownward-skills-flight-")); temps.push(home);
  const service = new SkillInventoryService({ home });
  const a = service.scan(), b = service.scan();
  expect(a).toBe(b); await a;
});
