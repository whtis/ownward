import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

const source = readFileSync(new URL("./chat.js", import.meta.url), "utf8");
const body = source.match(/function chatModelSelection\([\s\S]*?\n\}/)?.[0];
const select = Function(`${body}; return chatModelSelection;`)() as (models: string[], requested: string, existing: boolean) => string;

describe("web chat model selection", () => {
  test("default sentinel reopens history while a new Codex chat selects Sol", () => {
    const models = ["gpt-5.6-sol", "gpt-5.4", "default"];
    expect(select(models, "default", true)).toBe("default");
    expect(select(models, "default", false)).toBe("gpt-5.6-sol");
  });
});
