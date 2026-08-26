import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const chat = readFileSync(join(import.meta.dir, "..", "web", "chat.js"), "utf8");
const css = readFileSync(join(import.meta.dir, "..", "web", "style.css"), "utf8");

describe("chat responsive layout", () => {
  test("keeps messages and composer on the same readable rail", () => {
    expect(css).toContain(".chat-detail-col .session-scroll > .msg { width: min(100%, 980px)");
    expect(css).toContain(".chat-detail-col .composer-box { width: min(100%, 980px)");
  });

  test("lets mobile chat consume remaining height so the composer stays visible", () => {
    expect(css).toContain("#chat-root .session-pane { height: auto; min-height: 0; flex: 1; }");
  });

  test("switches chat alone to master-detail navigation at medium widths", () => {
    expect(css).toContain("@media (max-width: 1100px)");
    expect(css).toContain('#chat-root[data-mobile-view="detail"] .chat-list-col { display: none; }');
    expect(css).toContain('#chat-root:not([data-mobile-view="detail"]) .chat-detail-col { display: none; }');
    expect(css).toContain("#chat-root .chat-more > summary { display: inline-flex");
  });

  test("keeps the conversation heading fixed above a flexible scrolling list", () => {
    expect(css).toContain(".chat-list-col > .page-head { flex: none; }");
    expect(css).toContain(".chat-list-col > #ch-list { flex: 1; min-height: 0; }");
  });

  test("uses a compact mobile actions menu and touch-sized composer controls", () => {
    expect(chat).toContain('<details class="chat-more">');
    expect(chat).toContain('<summary class="button ghost sm">更多</summary>');
    expect(css).toContain(".chat-more[open] .chat-more-menu");
    expect(css).toContain(".composer-bar .hint { display: none; }");
    expect(css).toContain(".composer-bar .icon-btn, .composer-bar .button.primary { min-width: 40px; min-height: 40px; }");
  });

  test("allows conversation titles to occupy two lines", () => {
    expect(css).toContain("-webkit-line-clamp: 2");
  });

  test("shrink-wraps image buttons instead of letting wide source images stretch them", () => {
    expect(css).toContain(".msg-img {\n  display: inline-flex; flex: 0 1 auto; width: fit-content; max-width: min(340px, 70vw)");
    expect(css).toContain(".msg-imgs img { display: block; width: auto; height: auto; max-width: 100%; max-height: 280px; object-fit: contain; }");
    expect(css.match(/\.msg-imgs img\s*\{/g)).toHaveLength(1);
  });
});
