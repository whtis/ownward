import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(import.meta.dir, "image-viewer.js"), "utf8");
const start = src.indexOf("function safeTaskImageUrl");
const end = src.indexOf("function imageThumbsHtml");
const { safeTaskImageUrl, safeChatImageUrl } = new Function(
  `${src.slice(start, end)}; return { safeTaskImageUrl, safeChatImageUrl };`,
)() as { safeTaskImageUrl: (url: unknown) => string; safeChatImageUrl: (url: unknown) => string };

describe("image viewer URL allowlists", () => {
  test("task images accept only the two local image stores", () => {
    expect(safeTaskImageUrl("/api/agent-image/session-1/0123456789abcdef.png")).toBe("/api/agent-image/session-1/0123456789abcdef.png");
    const uploaded = `/api/session-image/session-1/${"a".repeat(64)}`;
    expect(safeTaskImageUrl(uploaded)).toBe(uploaded);
    expect(safeTaskImageUrl("/api/agent-image/session-1/../secret")).toBe("");
    expect(safeTaskImageUrl("https://evil.example/a.png")).toBe("");
    expect(safeTaskImageUrl("/api/chat/image?chat_id=x&id=y")).toBe("");
  });

  test("chat history accepts its existing read endpoint", () => {
    (globalThis as any).location = { origin: "http://127.0.0.1:4519" };
    expect(safeChatImageUrl("/api/chat/image?chat_id=c1&id=i1")).toBe("/api/chat/image?chat_id=c1&id=i1");
    expect(safeChatImageUrl("blob:http://127.0.0.1/local-preview")).toStartWith("blob:");
    expect(safeChatImageUrl("/api/chat/image?chat_id=c1")).toBe("");
    expect(safeChatImageUrl("javascript:alert(1)")).toBe("");
  });
});
