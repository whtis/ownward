import { describe, expect, it } from "bun:test";
import { isDownloadsPath } from "./workbench.ts";

describe("project path safety", () => {
  it("rejects Downloads paths lexically", () => {
    expect(isDownloadsPath("~/Downloads")).toBe(true);
    expect(isDownloadsPath("~/Downloads/headhunter_ai")).toBe(true);
    expect(isDownloadsPath("~/Downloads-other/project")).toBe(false);
    expect(isDownloadsPath("/tmp/ownward-project")).toBe(false);
  });
});
