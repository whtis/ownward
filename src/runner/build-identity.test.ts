import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, rmSync,writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runnerBuildIdentity } from "./build-identity.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Runner build identity", () => {
  test("all production src changes alter identity while tests and fixtures do not", async () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-runner-identity-")); roots.push(root); mkdirSync(join(root, "src"));
    cpSync(join(import.meta.dir, ".."), join(root, "src"), { recursive: true });
    const before = await runnerBuildIdentity(root); appendFileSync(join(root, "src", "providers", "claude-code", "adapter.ts"), "\n// identity regression\n");
    const providerChanged = await runnerBuildIdentity(root); expect(providerChanged).not.toBe(before);
    appendFileSync(join(root, "src", "runs", "repository.ts"), "\n// shared dependency regression\n"); const sharedChanged = await runnerBuildIdentity(root); expect(sharedChanged).not.toBe(providerChanged);
    appendFileSync(join(root, "src", "runner", "build-identity.test.ts"), "\n// test-only change\n"); appendFileSync(join(root, "src", "providers", "claude-code", "testing", "fake-claude.ts"), "\n// fixture-only change\n"); expect(await runnerBuildIdentity(root)).toBe(sharedChanged);
  });
  test("canonical Provider config changes Runner identity while unrelated config does not",async()=>{const root=mkdtempSync(join(tmpdir(),"ownward-runner-config-"));roots.push(root);mkdirSync(join(root,"src"));cpSync(join(import.meta.dir,".."),join(root,"src"),{recursive:true});writeFileSync(join(root,"config.default.json"),JSON.stringify({providers:{codex:{command:["codex"]}},dashboard:{port:1}}));const before=await runnerBuildIdentity(root);writeFileSync(join(root,"config.json"),JSON.stringify({dashboard:{port:2}}));expect(await runnerBuildIdentity(root)).toBe(before);writeFileSync(join(root,"config.json"),JSON.stringify({providers:{codex:{command:["codex-next"]}}}));expect(await runnerBuildIdentity(root)).not.toBe(before);});
});
