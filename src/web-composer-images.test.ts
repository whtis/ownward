import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const web = (name: string) => readFileSync(join(import.meta.dir, "..", "web", name), "utf8");
const src = web("composer-images.js");
const tasks = web("tasks.js");
const chat = web("chat.js");
const app = web("app.js");

type Fake = { size: number; type: string; name?: string };
const file = (size: number, type = "image/png", name = "a.png"): Fake => ({ size, type, name });

/** 把 composer-images.js 装进一个带桩 DOM 的作用域：
 *  - FileReader → base64 只看长度，内容无所谓
 *  - Image/canvas → 压缩产物大小由 shrinkTo 决定（null = 压不动） */
function load(opts: { shrinkTo?: number | null } = {}) {
  const toasts: string[] = [];
  const toast = (msg: string) => { toasts.push(String(msg)); };
  class FileReaderStub {
    result = ""; onload: (() => void) | null = null; onerror: (() => void) | null = null; error = null;
    readAsDataURL(blob: Fake) { this.result = `data:${blob.type};base64,${"A".repeat(blob.size)}`; queueMicrotask(() => this.onload?.()); }
  }
  class ImageStub {
    naturalWidth = 3000; naturalHeight = 4000; onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(_v: string) { queueMicrotask(() => this.onload?.()); }
  }
  const document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({ drawImage() {} }),
      toBlob: (cb: (b: Fake | null) => void) => cb(opts.shrinkTo === null || opts.shrinkTo === undefined ? null : { size: opts.shrinkTo, type: "image/jpeg" }),
    }),
  };
  const URLStub = { createObjectURL: () => "blob:stub", revokeObjectURL: () => {} };
  const api = new Function("toast", "FileReader", "Image", "document", "URL", "fetch",
    `${src}; return { prepareComposerImage, composerImageFits, COMPOSER_IMG_MAX, COMPOSER_IMG_BYTES, COMPOSER_IMG_TOTAL };`,
  )(toast, FileReaderStub, ImageStub, document, URLStub, async () => { throw new Error("no fetch"); });
  return { ...api, toasts };
}

describe("composer 图片流水线", () => {
  test("小图原样收下，media_type 与字节数照实带走", async () => {
    const { prepareComposerImage, toasts } = load();
    const image = await prepareComposerImage(file(1024, "image/png"));
    expect(image).toMatchObject({ media_type: "image/png", size: 1024 });
    expect(image.data).toHaveLength(1024);
    expect(toasts).toEqual([]);
  });

  test("超过单张上限的截图先压缩再收（这正是「附件超过 blob 上限」的来源）", async () => {
    const big = 9 * 1024 * 1024;   // base64 后 12MB，原样发必撞 Runner 8MiB blob 上限
    const { prepareComposerImage, COMPOSER_IMG_BYTES, toasts } = load({ shrinkTo: 900 * 1024 });
    const image = await prepareComposerImage(file(big, "image/png"));
    expect(image.media_type).toBe("image/jpeg");
    expect(image.size).toBeLessThanOrEqual(COMPOSER_IMG_BYTES);
    expect(toasts.join(" ")).toContain("已压缩后附上");   // 换掉了用户的图就明说
  });

  test("压不动 / 原图过大 / 类型不支持：当场拒绝并说原因，不静默丢", async () => {
    const unshrinkable = load({ shrinkTo: null });
    expect(await unshrinkable.prepareComposerImage(file(9 * 1024 * 1024, "image/png"))).toBeNull();
    expect(unshrinkable.toasts.join(" ")).toContain("先压缩一下");

    const huge = load({ shrinkTo: 1024 });
    expect(await huge.prepareComposerImage(file(30 * 1024 * 1024, "image/png"))).toBeNull();
    expect(huge.toasts.join(" ")).toContain("图片太大");

    const wrong = load();
    expect(await wrong.prepareComposerImage(file(1024, "application/pdf", "a.pdf"))).toBeNull();
    expect(wrong.toasts.join(" ")).toContain("只支持");

    // GIF 不重编码（会把动图拍成静图），超限就明确拒绝
    const gif = load({ shrinkTo: 1024 });
    expect(await gif.prepareComposerImage(file(9 * 1024 * 1024, "image/gif", "a.gif"))).toBeNull();
    expect(gif.toasts.join(" ")).toContain("单张不能超过");
  });

  test("张数与合计上限", () => {
    const { composerImageFits, COMPOSER_IMG_MAX, COMPOSER_IMG_TOTAL, toasts } = load();
    expect(composerImageFits([], 1024)).toBe(true);
    expect(composerImageFits(Array.from({ length: COMPOSER_IMG_MAX }, () => ({ size: 1 })), 1024)).toBe(false);
    expect(composerImageFits([{ size: COMPOSER_IMG_TOTAL }], 1024)).toBe(false);
    expect(toasts).toHaveLength(2);
  });
});

describe("三个 composer 都走同一条流水线", () => {
  test("任务追问、AI 对话、派发弹窗都不再直接 readAsDataURL 原图", () => {
    for (const [name, source] of [["tasks.js", tasks], ["chat.js", chat], ["app.js", app]] as const) {
      expect(source, name).toContain("prepareComposerImage");
      expect(source, name).toContain("composerImageFits");
    }
    expect(tasks).not.toContain("readAsDataURL");
    expect(chat).not.toContain("readAsDataURL");
    expect(app.slice(app.indexOf("const addWorkImg"), app.indexOf("#w-attach"))).not.toContain("readAsDataURL");
  });
});
