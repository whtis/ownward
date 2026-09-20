import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";

// 只取 esc + mdHtml 两段源码求值，不拉起整页
const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
const escSrc = app.slice(app.indexOf("const esc ="), app.indexOf("\n", app.indexOf("const esc =")));
const mdSrc = app.slice(app.indexOf("function mdHtml(src)"), app.indexOf("const hhmm ="));
const mdHtml = new Function(`${escSrc}\n${mdSrc}\nreturn mdHtml;`)() as (s: string) => string;
const hrefs = (html: string) => [...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]);

describe("mdHtml bare-URL autolink", () => {
  test("bare URL after Chinese colon on its own line becomes clickable", () => {
    const html = mdHtml("回读确认内容和位置都对：\nhttps://example.feishu.cn/wiki/AbCdEfGhIjKlMnOpQrStUvWxYz");
    expect(hrefs(html)).toEqual(["https://example.feishu.cn/wiki/AbCdEfGhIjKlMnOpQrStUvWxYz"]);
    expect(html).toContain('target="_blank" rel="noopener">https://example.feishu.cn/wiki/AbCdEfGhIjKlMnOpQrStUvWxYz</a>');
  });

  test("URL stops at full-width punctuation and drops trailing ASCII punctuation", () => {
    expect(hrefs(mdHtml("见 https://a.com/x，然后"))).toEqual(["https://a.com/x"]);
    expect(hrefs(mdHtml("文档（https://a.com/y）里"))).toEqual(["https://a.com/y"]);
    expect(hrefs(mdHtml("see https://a.com/z."))).toEqual(["https://a.com/z"]);
    expect(hrefs(mdHtml("- 地址：https://a.com/q?x=1&y=2"))).toEqual(["https://a.com/q?x=1&amp;y=2"]);
    expect(hrefs(mdHtml("<https://a.com/b>"))).toEqual(["https://a.com/b"]);
  });

  test("markdown links are not double-wrapped and code spans stay plain", () => {
    const html = mdHtml("[文档](https://a.com/d) 和 `https://a.com/code`");
    expect(hrefs(html)).toEqual(["https://a.com/d"]);
    expect(html).toContain("<code>https://a.com/code</code>");
    expect(hrefs(mdHtml("[https://a.com/e](https://a.com/e)"))).toEqual(["https://a.com/e"]);
  });

  test("non-http schemes are never linked", () => {
    expect(hrefs(mdHtml("javascript:alert(1) [x](javascript:alert(1))"))).toEqual([]);
  });
});
