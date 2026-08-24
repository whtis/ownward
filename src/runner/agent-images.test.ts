// 会话图片仓的安全边界与幂等：这是把 agent 眼里的图暴露给旁观端的口子——
// key/file 逃逸 = 任意文件读，嗅探失守 = 存任意二进制。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { agentImageRoot, readAgentImage, saveAgentImage, saveContentImages } from "./agent-images.ts";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const root = () => mkdtempSync(join(tmpdir(), "agimg-"));

describe("agent-images 仓", () => {
  test("落盘幂等 + URL 稳定 + 路由能读回", () => {
    const data = root();
    const u1 = saveAgentImage(data, "sess-1", PNG_B64);
    const u2 = saveAgentImage(data, "sess-1", PNG_B64);
    expect(u1).toBe(u2);
    expect(u1).toMatch(/^\/api\/agent-image\/sess-1\/[a-f0-9]{16}\.png$/);
    const file = u1!.split("/").pop()!;
    const img = readAgentImage(data, "sess-1", file);
    expect(img?.mime).toBe("image/png");
    expect(img!.bin.length).toBeGreaterThan(0);
  });

  test("key 逃逸 fail closed：`..`/斜杠/非法字符一律拒", () => {
    const data = root();
    expect(saveAgentImage(data, "../evil", PNG_B64)).toBeNull();
    expect(saveAgentImage(data, "a/b", PNG_B64)).toBeNull();
    expect(readAgentImage(data, "..", "0".repeat(16) + ".png")).toBeNull();
    expect(readAgentImage(data, "sess-1", "../../secrets.png")).toBeNull();
    expect(readAgentImage(data, "sess-1", "abc.png")).toBeNull(); // 文件名不满足 sha16 正则
  });

  test("魔数嗅探失守即拒：非图片二进制/声明造假不落盘", () => {
    const data = root();
    expect(saveAgentImage(data, "s", Buffer.from("#!/bin/sh\nrm -rf /").toString("base64"))).toBeNull();
    expect(saveAgentImage(data, "s", "")).toBeNull();
    expect(saveAgentImage(data, "s", 123 as any)).toBeNull();
  });

  test("saveContentImages 捞顶层与 tool_result 内层图片块", () => {
    const data = root();
    const urls = saveContentImages(data, "sess-2", [
      { type: "image", source: { type: "base64", data: PNG_B64 } },
      { type: "tool_result", content: [{ type: "image", source: { type: "base64", data: PNG_B64 } }, { type: "text", text: "x" }] },
      { type: "text", text: "无关" },
    ]);
    expect(urls).toHaveLength(1); // 同一张图去重
    expect(urls[0]).toContain("/api/agent-image/sess-2/");
  });

  test("全仓配额 GC：超限删 mtime 最老的（观测数据容忍丢失）", () => {
    const data = root();
    // 直接铺 501 个假图文件（绕过 save 的嗅探，测 GC 本体）
    const dir = join(agentImageRoot(data), "bulk");
    require("fs").mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 501; i++) {
      const f = join(dir, `${String(i).padStart(16, "0")}.png`);
      writeFileSync(f, "x");
      utimesSync(f, new Date(1700000000000 + i * 1000), new Date(1700000000000 + i * 1000));
    }
    saveAgentImage(data, "bulk", PNG_B64); // 触发 GC
    const left = readdirSync(dir).length;
    expect(left).toBeLessThanOrEqual(500);
    expect(statSync(join(dir, "0000000000000500.png"))).toBeDefined(); // 最新的活着
  });
});
