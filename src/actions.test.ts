import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
test("revive reopens only terminal actions and preserves snooze state", async () => {
  const root = mkdtempSync(join(tmpdir(), "ownward-actions-"));
  try {
    const mod = JSON.stringify(join(import.meta.dir, "actions.ts")),
      script = `import{openAction,setActionState,listActions,resolveActionExact}from ${mod};const base={kind:"review",source:"github",title:"x",reason:"x",ref:{}};openAction({id:"s",...base});setActionState("s","snoozed",60);openAction({id:"s",...base},{revive:true});openAction({id:"r",...base});setActionState("r","resolved");openAction({id:"r",...base},{revive:true});openAction({id:"prefix",...base});openAction({id:"prefix-child",...base});const exact=resolveActionExact("prefix","ignored");console.log(JSON.stringify({rows:listActions(true),exact}))`,
      proc = Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, OWNWARD_DATA_ROOT: root },
        stdout: "pipe",
        stderr: "pipe",
      }),
      out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const result = JSON.parse(out.trim().split("\n").at(-1)!), rows = result.rows;
    expect(result.exact).toBeTrue();
    expect(rows.find((x: any) => x.id === "prefix")).toMatchObject({ state: "resolved", resolution: "ignored" });
    expect(rows.find((x: any) => x.id === "prefix-child")).toMatchObject({ state: "open" });
    expect(rows.find((x: any) => x.id === "s")).toMatchObject({
      state: "snoozed",
    });
    expect(rows.find((x: any) => x.id === "s").snoozedUntil).toBeString();
    expect(rows.find((x: any) => x.id === "r")).toMatchObject({
      state: "open",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
