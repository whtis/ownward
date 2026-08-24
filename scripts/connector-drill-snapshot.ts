import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

// These files are written by a healthy idle daemon and do not carry user/domain
// truth. Everything else remains protected, notably tasks, sessions, actions,
// runner journals, event/feed journals and migration/schema/config surfaces.
const VOLATILE = [
  /^state\.json$/,
  /^daemon\.pid$/,
  /^logs\//,
  /^boots(?:\.json)?(?:\/|\.|$)/,
  /^connectors\/[^/]+\/(?:checkpoint\.json|health\.json)$/,
];

export function drillSurface(path: string): "excluded" | "volatile" | "protected" {
  if (path === "secrets" || path.startsWith("secrets/")) return "excluded";
  return VOLATILE.some((pattern) => pattern.test(path)) ? "volatile" : "protected";
}

export function connectorDrillSnapshot(root: string, surface: "all" | "protected" = "protected") {
  const files: string[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), rel = relative(root, path), kind = drillSurface(rel);
      if (kind === "excluded") continue;
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() && (surface === "all" || kind === "protected")) files.push(path);
    }
  }
  walk(root); files.sort();
  const digest = createHash("sha256"), count = (prefix: string) => files.filter((path) => relative(root, path).startsWith(prefix)).length;
  for (const path of files) {
    digest.update(relative(root, path));
    digest.update(createHash("sha256").update(readFileSync(path)).digest());
  }
  const json = (name: string) => { try { return JSON.parse(readFileSync(join(root, name), "utf8")); } catch { return null; } };
  const actions = json("actions.json"), sessions = (existsSync(join(root, "kernel/sessions.json")) ? json("kernel/sessions.json") : json("sessions.json"))?.sessions;
  const sessionRows = Array.isArray(sessions) ? sessions : Object.values(sessions || {});
  return { surface, files: files.length, digest: digest.digest("hex"), eventFiles: count("events/"), taskFiles: count("tasks/"), actions: Array.isArray(actions) ? actions.length : 0, sessions: sessionRows.length, pinned: sessionRows.filter((row: any) => row?.pinned === true).length };
}

if (import.meta.main) {
  const root = process.argv[2], surface = process.argv[3] === "all" ? "all" : "protected";
  if (!root) { console.error("usage: connector-drill-snapshot.ts <data-root> [protected|all]"); process.exit(2); }
  console.log(JSON.stringify(connectorDrillSnapshot(root, surface)));
}
