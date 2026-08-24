import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { inventoryMigrationCopy } from "./data-migration-inventory.ts";

describe("data migration dry-run inventory", () => {
  test("reports only counts/hashes and validates task/session/pinned/action refs", () => {
    const root = mkdtempSync(join(tmpdir(), "ownward-migration-inventory-"));
    try {
      writeFileSync(join(root, ".ownward-connector-drill-copy"), "");
      writeFileSync(join(root, "schema.json"), JSON.stringify({ version: 1, applied: [] }));
      writeFileSync(join(root, "tasks.json"), JSON.stringify([{ id: "private-task", prompt: "must-not-leak" }]));
      writeFileSync(join(root, "sessions.json"), JSON.stringify({ schemaVersion:1, sessions: [{ id: "private-session", taskIds: ["private-task"], nativeRef: "secret-ref" }] }));
      writeFileSync(join(root, "pinned-sessions.json"), JSON.stringify([{ ref: "secret-ref" }]));
      writeFileSync(join(root, "actions.json"), JSON.stringify([{ id: "private-action", ref: { task_id: "private-task" } }]));
      mkdirSync(join(root, "tasks")); writeFileSync(join(root, "tasks", "private-task.log"), "private output");
      const result = inventoryMigrationCopy(root), encoded = JSON.stringify(result);
      expect(result.cardinality).toEqual({ tasks: 1, sessions: 1, pinned: 1, actions: 1 });
      expect(result.keyRefs).toMatchObject({ total: 3, resolved: 3, dangling: 0 });
      expect(result.applyEligible).toBe(true);
      expect(result.surfaces.taskArtifacts.files).toBe(1);
      for (const secret of ["private-task", "private-session", "private-action", "secret-ref", "must-not-leak", "private output"]) expect(encoded).not.toContain(secret);
      writeFileSync(join(root, "sessions.json"), JSON.stringify({ schemaVersion:1, sessions: [{ id: "orphan-session", taskIds: ["missing-task"], nativeRef: "orphan-ref" }] }));
      const blocked = inventoryMigrationCopy(root);
      expect(blocked).toMatchObject({ applyEligible: false, keyRefs: { dangling: 2, blocking: 2, tolerated: 0 } });
      mkdirSync(join(root,"kernel"));writeFileSync(join(root,"kernel/sessions.json"),JSON.stringify({schemaVersion:1,sessions:[{id:"orphan-session",taskIds:[],nativeRef:"orphan-ref",archive:{state:"orphaned-task-link",originalTaskRefs:["missing-task"],migrationId:"stage6-kernel-sessions-v1",reason:"task-record-missing",sourceAggregateSha256:"a".repeat(64)}}]}));
      const migrated=inventoryMigrationCopy(root);expect(migrated).toMatchObject({canonicalSessionStore:"kernel",applyEligible:false,keyRefs:{archived:{total:1,valid:1}}});
      mkdirSync(join(root, "secrets")); expect(() => inventoryMigrationCopy(root)).toThrow("INVENTORY_SECRETS_PRESENT");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("future schema and corrupt critical stores fail closed",()=>{for(const kind of["future","tasks","sessions"]){const root=mkdtempSync(join(tmpdir(),"ownward-migration-invalid-"));try{writeFileSync(join(root,".ownward-connector-drill-copy"),"");writeFileSync(join(root,"schema.json"),JSON.stringify({version:kind==="future"?2:1,applied:[]}));writeFileSync(join(root,"tasks.json"),kind==="tasks"?"{": "[]");writeFileSync(join(root,"sessions.json"),kind==="sessions"?"{":JSON.stringify({schemaVersion:1,sessions:[]}));writeFileSync(join(root,"pinned-sessions.json"),"[]");writeFileSync(join(root,"actions.json"),"[]");expect(()=>inventoryMigrationCopy(root)).toThrow(kind==="future"?"INVENTORY_SCHEMA_UNSUPPORTED":"INVENTORY_CRITICAL_STORE_INVALID");}finally{rmSync(root,{recursive:true,force:true});}}});
});
