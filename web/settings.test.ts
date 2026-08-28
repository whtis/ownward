import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("./settings.js", import.meta.url), "utf8");

describe("settings and skill control plane", () => {
  test("keeps settings distinct from system status and registers seven categories", () => {
    expect(html).toContain('data-pane="system"');
    expect(html).toContain('data-pane="settings"');
    expect(html).toContain('<script src="/settings.js"></script>');
    for (const id of ["general", "engines", "skills", "sources", "automation", "notifications", "advanced"])
      expect(js).toContain(`["${id}",`);
  });

  test("stages, validates, approves and monitors settings operations", () => {
    for (const endpoint of ["/api/settings/schema", "/api/settings/effective", "/api/settings/validate", "/api/settings/approve", "/api/settings/apply", "/api/settings/operations/current"])
      expect(js).toContain(endpoint);
    expect(js).toContain("Settings.draft");
    expect(js).toContain("redactedDiff");
    expect(js).toContain("批准并重启 Ownward");
    expect(js).toContain("pollSettingsOperation");
  });

  test("supports agent proposals, deterministic plans, approvals, transactions and rollback", () => {
    for (const endpoint of ["/api/skills/scan", "/api/skills/analysis", "/api/skills/plan", "/api/skills/apply", "/api/skills/transactions"])
      expect(js).toContain(endpoint);
    for (const marker of ["METADATA ONLY", "批准并执行", "CONDITIONAL ROLLBACK", "manual-repair", "扫描结果不完整", "降级为只读"])
      expect(js).toContain(marker);
  });

  test("only renders schema leaves explicitly marked editable", () => {
    expect(js).toContain("field.metadata?.editable");
    expect(js).not.toContain('CATEGORY_ROOTS.release');
    expect(js).not.toContain('CATEGORY_ROOTS.verticals');
  });
});
