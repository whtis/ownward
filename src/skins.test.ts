// HEIC 转码的单测：走真实 sips 路径（ownward 只跑 macOS，sips 系统自带）。
// 样张用 sips 从 1x1 PNG 现场生成——仓库不进二进制 fixture。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { convertHeicToJpeg } from "./skins.ts";

const dir = mkdtempSync(join(tmpdir(), "ownward-skins-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function makeHeic(): Promise<Buffer> {
  const png = join(dir, "in.png"), heic = join(dir, "in.heic");
  // 最小合法 PNG（1x1 红色像素）
  writeFileSync(png, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"));
  const p = Bun.spawn(["sips", "-s", "format", "heic", png, "--out", heic], { stdout: "ignore", stderr: "ignore" });
  expect(await p.exited).toBe(0);
  return readFileSync(heic);
}

describe("convertHeicToJpeg", () => {
  test("真 HEIC 转出 JPEG（SOI 魔数 0xFFD8）", async () => {
    const r = await convertHeicToJpeg(await makeHeic());
    expect(r.ok).toBe(true);
    expect(r.jpeg![0]).toBe(0xff);
    expect(r.jpeg![1]).toBe(0xd8);
  });

  test("非 ISO-BMFF 字节直接拒绝，不喂 sips", async () => {
    const r = await convertHeicToJpeg(Buffer.from("not an image at all, definitely"));
    expect(r.ok).toBe(false);
    expect(r.msg).toContain("不是有效的 HEIC");
  });

  test("ftyp 魔数对但内容坏：sips 失败要报错而不是假成功", async () => {
    const fake = Buffer.alloc(64);
    fake.write("ftyp", 4, "latin1");
    const r = await convertHeicToJpeg(fake);
    expect(r.ok).toBe(false);
    expect(r.msg).toContain("转码失败");
  });
});

// 对比度护栏：直方图取的 accent 可能和底色同亮度导致 UI 不可读（主仓 SkinModels 有 4.5:1 校验）
describe("ensureReadableAccent", () => {
  const { ensureReadableAccent } = require("./skins.ts") as typeof import("./skins.ts");
  const lum = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

  test("深色主题里近黑 accent 被调亮到 ≥3:1", () => {
    const out = ensureReadableAccent("#141216", "dark");
    expect(ratio(out, "#100f11")).toBeGreaterThanOrEqual(3);
  });
  test("浅色主题里近白 accent 被调暗到 ≥3:1", () => {
    const out = ensureReadableAccent("#f2f0ee", "light");
    expect(ratio(out, "#f5f3f1")).toBeGreaterThanOrEqual(3);
  });
  test("本来就可读的颜色原样保留", () => {
    expect(ensureReadableAccent("#63a8ff", "dark")).toBe("#63a8ff");
  });
});
