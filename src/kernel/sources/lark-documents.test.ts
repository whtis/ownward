import { describe, expect, test } from "bun:test";
import { LarkDocumentSources, type SourceCommandRunner } from "./lark-documents.ts";

function runner(responses: Array<{ exitCode?: number; stdout?: string; stderr?: string }>, calls: string[][]): SourceCommandRunner {
  return async (args) => {
    calls.push([...args]);
    const next = responses.shift()!;
    return { exitCode: next.exitCode ?? 0, stdout: next.stdout ?? "", stderr: next.stderr ?? "" };
  };
}

describe("Lark document source", () => {
  test("inspect unwraps wiki and fetch returns a revisioned markdown snapshot", async () => {
    const calls: string[][] = [];
    const source = new LarkDocumentSources(runner([
      { stdout: JSON.stringify({ input_url: "https://acme.feishu.cn/wiki/wik1", type: "docx", title: "带教复盘", token: "dox1", url: "https://acme.feishu.cn/docx/dox1" }) },
      { stdout: JSON.stringify({ ok: true, data: { document: { document_id: "dox1", revision_id: 12, content: "# 带教复盘\n\n沟通内容" } } }) },
    ], calls));
    const snapshot = await source.fetch({ provider: "lark", url: "https://acme.feishu.cn/wiki/wik1" });
    expect(snapshot).toMatchObject({ provider: "lark", canonicalId: "dox1", type: "docx", title: "带教复盘", revision: "12", contentType: "text/markdown" });
    expect(snapshot.contentHash).toHaveLength(64);
    expect(calls[0]).toContain("+inspect");
    expect(calls[1]).toContain("with-ids");
    expect(calls.every((call) => call.includes("user"))).toBeTrue();
  });

  test("rejects non-Lark URLs before invoking the CLI", async () => {
    const calls: string[][] = [];
    const source = new LarkDocumentSources(runner([], calls));
    await expect(source.inspect({ provider: "lark", url: "https://example.com/docx/nope" })).rejects.toMatchObject({ code: "SOURCE_URL_DENIED" });
    expect(calls).toHaveLength(0);
  });

  test("unsupported resource types fail explicitly", async () => {
    const source = new LarkDocumentSources(runner([{ stdout: JSON.stringify({ type: "sheet", title: "表格", token: "sht1", url: "https://acme.feishu.cn/sheets/sht1" }) }], []));
    await expect(source.inspect({ provider: "lark", url: "https://acme.feishu.cn/wiki/wik1" })).rejects.toMatchObject({ code: "SOURCE_TYPE_UNSUPPORTED" });
  });

  test("status is non-throwing when user auth is missing", async () => {
    const source = new LarkDocumentSources(runner([{ exitCode: 1, stderr: "not logged in" }], []));
    expect(await source.status("lark")).toEqual({ provider: "lark", available: true, authenticated: false, identity: "user", message: "飞书账号尚未连接" });
  });
});
