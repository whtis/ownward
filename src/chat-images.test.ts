import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import {
  ATTACH_ROOT, chatAttachDir,
  deleteChatAttachments, persistChatImages, readChatImage, validateChatImages,
} from "./chat-images.ts";
import { claudeArgs, claudeUserFrame } from "./chat.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ids: string[] = [];
afterAll(() => { for (const id of ids) deleteChatAttachments(id); });

describe("chat 图片校验与受控存储", () => {
  test("拒绝路径穿越、伪装类型和非规范 base64", () => {
    expect(chatAttachDir("../../outside")).toBeNull();
    expect(validateChatImages([{ media_type: "image/png", data: Buffer.from("<script>").toString("base64") }]).ok).toBe(false);
    expect(validateChatImages([{ media_type: "image/png", data: PNG.toString("base64").replace(/=$/, "") }]).ok).toBe(false);
  });

  test("消息只存元数据，读取必须由该对话消息授权，删除会清目录", () => {
    const id = `testimg${Date.now().toString(36)}`; ids.push(id);
    const v = validateChatImages([{ media_type: "image/png", data: PNG.toString("base64") }]);
    if (!("images" in v)) throw new Error(v.msg);
    const saved = persistChatImages(id, v.images);
    expect(saved.metas[0]).toEqual(expect.objectContaining({ mediaType: "image/png", bytes: PNG.length }));
    expect((saved.metas[0] as any).data).toBeUndefined();
    expect(readChatImage({ id, messages: [] }, saved.metas[0].id)).toBeNull();
    expect(readChatImage({ id, messages: [{ images: saved.metas }] }, saved.metas[0].id)?.bin).toEqual(PNG);
    deleteChatAttachments(id);
    expect(existsSync(join(ATTACH_ROOT, id))).toBe(false);
  });
});

describe("provider 图片投递", () => {
  test("Claude 使用 stream-json 图片帧", () => {
    const chat: any = { model: "opus", provider: "claude" };
    const args = claudeArgs(chat, "看图", "system", true);
    expect(args).toContain("--input-format");
    expect(args).not.toContain("看图");
    const frame = JSON.parse(claudeUserFrame("看图", [{ mediaType: "image/png", ext: "png", bin: PNG }]));
    expect(frame.message.content[0].source.media_type).toBe("image/png");
    expect(frame.message.content[0].source.data).toBe(PNG.toString("base64"));
    expect(frame.message.content[1].text).toBe("看图");
  });
});
