// 皮肤存储：自定义皮肤 JSON + 壁纸资产（sha 寻址，data/skins/）。
// 内置皮肤定义在 web/skin.js；daemon 只管自定义皮肤的增删列与资产服务。
// 安全边界：id/资产名严格正则（无路径拼接面）、只收 webp/jpeg/png dataURL、
// 单图 6MB / 总量 30 个配额；图片是客户端 canvas 重编码过的（EXIF/GPS 已剥）。
// HEIC 例外：Chromium 前端解不了，先经 convertHeicToJpeg（macOS sips）转成 jpeg
// 回传前端，再走上面同一条 canvas 重编码入库路径——存储格式白名单不变。
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DATA, run } from "./util.ts";

const SKINS_DIR = join(DATA, "skins");
const ASSETS_DIR = join(SKINS_DIR, "assets");
const HEX = /^#[0-9a-fA-F]{6}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{2,40}$/;
const ASSET_RE = /^[a-f0-9]{16,64}\.(webp|jpe?g|png)$/;
const MAX_CUSTOM = 30;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export interface CustomSkin {
  id: string; name: string; mode: "dark" | "light";
  accent: string; accent2: string; asset: string;
  custom: true; createdAt: string;
}

export function listSkins(): CustomSkin[] {
  if (!existsSync(SKINS_DIR)) return [];
  const out: CustomSkin[] = [];
  for (const f of readdirSync(SKINS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try { out.push(JSON.parse(readFileSync(join(SKINS_DIR, f), "utf8"))); } catch { /* 单个坏文件不炸列表 */ }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

// —— WCAG 对比度护栏（主仓 SkinModels 的 4.5:1 校验在网页化时掉了）——
// accent 是交互色/强调文本色，直方图取色可能取出与底色几乎同亮度的颜色导致 UI 不可读。
// 这里不硬拒（前端是自动取色，用户没得改），而是确定性调亮/调暗到 ≥3:1（WCAG 1.4.11 组件最低线）。
const relLum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: string, b: string): number => {
  const [l1, l2] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};
export function ensureReadableAccent(hex: string, mode: "dark" | "light"): string {
  const bg = mode === "dark" ? "#100f11" : "#f5f3f1";  // 两套主题的 --sf-canvas 实色种子
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (let i = 0; i < 20 && contrast(`#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`, bg) < 3; i++) {
    // 深色主题往亮调、浅色主题往暗调，每步 10%，保色相
    const f = mode === "dark" ? 1.1 : 0.9;
    [r, g, b] = [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(mode === "dark" ? v * f + 8 : v * f))));
  }
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function createSkin(body: any): { ok: boolean; msg?: string; skin?: CustomSkin } {
  const name = String(body?.name || "").trim().slice(0, 24) || "自定义";
  const mode = body?.mode === "light" ? "light" : "dark";
  let accent = String(body?.accent || "");
  let accent2 = String(body?.accent2 || "");
  if (!HEX.test(accent) || !HEX.test(accent2)) return { ok: false, msg: "accent 颜色不合法" };
  accent = ensureReadableAccent(accent.toLowerCase(), mode);
  accent2 = ensureReadableAccent(accent2.toLowerCase(), mode);
  const m = String(body?.image || "").match(/^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return { ok: false, msg: "壁纸必须是 webp/jpeg/png dataURL" };
  const bin = Buffer.from(m[2], "base64");
  if (bin.length > MAX_IMAGE_BYTES) return { ok: false, msg: `壁纸超限（${(bin.length / 1048576).toFixed(1)}MB > 6MB）` };
  if (bin.length < 64) return { ok: false, msg: "图片数据不完整" };
  if (listSkins().length >= MAX_CUSTOM) return { ok: false, msg: `自定义皮肤已达上限 ${MAX_CUSTOM} 个，先删几个` };
  mkdirSync(ASSETS_DIR, { recursive: true });
  const ext = m[1] === "jpeg" ? "jpg" : m[1];
  const sha = createHash("sha256").update(bin).digest("hex").slice(0, 40);
  const asset = `${sha}.${ext}`;
  writeFileSync(join(ASSETS_DIR, asset), bin);
  const id = `c-${sha.slice(0, 8)}`;
  const skin: CustomSkin = { id, name, mode, accent, accent2, asset, custom: true, createdAt: new Date().toISOString() };
  writeFileSync(join(SKINS_DIR, `${id}.json`), JSON.stringify(skin, null, 2));
  return { ok: true, skin };
}

export function deleteSkin(id: string): { ok: boolean; msg: string } {
  if (!ID_RE.test(String(id || ""))) return { ok: false, msg: "id 不合法" };
  const f = join(SKINS_DIR, `${id}.json`);
  if (!existsSync(f)) return { ok: false, msg: "皮肤不存在" };
  let asset = "";
  try { asset = JSON.parse(readFileSync(f, "utf8")).asset || ""; } catch { /* 元数据坏了也照删 */ }
  rmSync(f);
  // 资产 sha 寻址可能被多个皮肤复用：无引用才删
  if (ASSET_RE.test(asset) && !listSkins().some((s) => s.asset === asset)) {
    try { rmSync(join(ASSETS_DIR, asset)); } catch { /* 资产残留不阻塞 */ }
  }
  return { ok: true, msg: "已删除" };
}

/** HEIC → JPEG（借 macOS 自带 sips，零新依赖）。只转格式不缩放——尺寸由前端 canvas 统一管（sips -Z 会把小图放大） */
export async function convertHeicToJpeg(bin: Buffer): Promise<{ ok: boolean; msg?: string; jpeg?: Buffer }> {
  // HEIC 是 ISO-BMFF 容器：offset 4 起必为 "ftyp"，不匹配就别喂 sips
  if (bin.length < 16 || bin.toString("latin1", 4, 8) !== "ftyp") return { ok: false, msg: "不是有效的 HEIC 文件" };
  let dir = "";
  try {
    dir = mkdtempSync(join(tmpdir(), "ownward-heic-"));
    const src = join(dir, "in.heic"), dst = join(dir, "out.jpg");
    writeFileSync(src, bin);
    const r = await run(["sips", "-s", "format", "jpeg", src, "--out", dst], { timeoutMs: 30_000 });
    if (r.code !== 0 || !existsSync(dst)) {
      const why = r.code === 124 ? "sips 超时（30s）" : r.stderr.trim().slice(0, 120) || `sips 退出码 ${r.code}`;
      return { ok: false, msg: `HEIC 转码失败：${why}` };
    }
    return { ok: true, jpeg: readFileSync(dst) };
  } catch (e) {
    // sips 不存在 / 磁盘写失败等意外：归为明确错误回给前端，不许异常穿透路由变裸 500
    return { ok: false, msg: `HEIC 转码失败：${String(e).slice(0, 120)}` };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

export function skinAsset(file: string): { bin: Buffer; mime: string } | null {
  if (!ASSET_RE.test(file)) return null;
  const p = join(ASSETS_DIR, file);
  if (!existsSync(p)) return null;
  const mime = file.endsWith(".webp") ? "image/webp" : file.endsWith(".png") ? "image/png" : "image/jpeg";
  return { bin: readFileSync(p), mime };
}
