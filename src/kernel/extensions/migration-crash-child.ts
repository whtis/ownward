import { appendFileSync } from "fs";
import { runExtensionMigration } from "./migration.ts";

const [dataRoot, id, version, crashStage, callsFile] = process.argv.slice(2);
if (!dataRoot || !id || !version || !crashStage || !callsFile) process.exit(2);
await runExtensionMigration({
  dataRoot,
  kind: "vertical",
  id,
  version,
  migrate: async ({ storage }) => {
    appendFileSync(callsFile, `${id}\n`);
    await storage.writeJson("state.json", { id, version });
    await Bun.sleep(Number(process.env.OWNWARD_MIGRATION_HOOK_DELAY_MS || 40));
  },
  fault: (stage) => {
    if (stage === crashStage) process.kill(process.pid, "SIGKILL");
  },
});
