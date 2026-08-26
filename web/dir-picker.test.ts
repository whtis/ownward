import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const app = readFileSync(join(import.meta.dir, "app.js"), "utf8");

describe("directory picker stacking contract", () => {
  test("moves the shared picker to the end of body before binding it", () => {
    const binding = app.slice(app.indexOf("function bindDirPicker()"), app.indexOf("/* ============ ⌘K"));
    expect(binding).toContain('const dirOverlay = $("#dir-overlay")');
    expect(binding.indexOf("document.body.append(dirOverlay)")).toBeGreaterThan(-1);
    expect(binding.indexOf("document.body.append(dirOverlay)")).toBeLessThan(binding.indexOf("dirOverlay.addEventListener"));
  });

  test("both directory inputs use the shared picker and preserve their selection targets", () => {
    expect(app).toContain('$("#w-browse").addEventListener("click", () =>\n    openDirPicker((dir) => { $("#w-dir").value = dir;');
    expect(app).toContain('$("#add-dir-browse").addEventListener("click", () =>\n    openDirPicker((dir) => { $("#add-dir-input").value = dir;');
    expect(app).toContain('$("#w-extra-browse").addEventListener("click", () =>\n    openDirPicker((dir) => addWorkExtraDir(dir)');
    expect(app).toContain('function dpPick(path) { const f = DP.onPick; dpClose(); f?.(path); }');
    expect(app).toContain('$("#dp-cancel").addEventListener("click", dpClose)');
  });
});
