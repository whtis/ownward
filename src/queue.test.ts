// 忙时输入队列合并的单测：/btw 识别 + 合并顺序（补充背景前置、普通消息顺序拼接）+ 斜杠命令独占一帧。
import { describe, expect, test } from "bun:test";
import { mergeQueued, parseQueued, sliceQueue } from "./agent-session.ts";

describe("parseQueued /btw 识别", () => {
  test("/btw 前缀去掉并打标记", () => {
    expect(parseQueued("/btw 顺便看下 README", [])).toMatchObject({ text: "顺便看下 README", images: [], btw: true });
    expect(parseQueued("/BTW 大小写不敏感", [])).toMatchObject({ btw: true, text: "大小写不敏感" });
  });
  test("普通消息不打标记", () => {
    expect(parseQueued("继续实现", [])).toMatchObject({ text: "继续实现", images: [], btw: false });
    // 不带空格的 /btwxxx 不算指令
    expect(parseQueued("/btwno-space", []).btw).toBe(false);
  });
  // 撤回按 id 认人：同文本的两条也必须是两个身份，否则撤一条会撤掉另一条
  test("每条都拿到互不相同的 id", () => {
    const ids = new Set(Array.from({ length: 50 }, () => parseQueued("同一句话", []).id));
    expect(ids.size).toBe(50);
    expect([...ids].every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });
});

describe("mergeQueued 合并", () => {
  const item = (text: string, btw = false) => parseQueued(btw ? `/btw ${text}` : text, []);

  test("多条普通消息按顺序空行拼接", () => {
    expect(mergeQueued([item("先做A"), item("再做B")]).text).toBe("先做A\n\n再做B");
  });

  test("/btw 补充作为背景前置在普通消息之前", () => {
    const { text } = mergeQueued([item("改登录逻辑"), item("注意别动样式", true)]);
    expect(text.startsWith("（用户补充背景，供参考）\n- 注意别动样式")).toBe(true);
    expect(text.endsWith("改登录逻辑")).toBe(true);
  });

  test("只有 /btw、无普通消息时也成立", () => {
    expect(mergeQueued([item("补一句", true)]).text).toBe("（用户补充背景，供参考）\n- 补一句");
  });

  test("图片跨条目汇总", () => {
    const img = { media_type: "image/png", data: "x" };
    const merged = mergeQueued([parseQueued("a", [img]), parseQueued("b", [img])]);
    expect(merged.images.length).toBe(2);
  });

  test("空白条目被过滤，不产生多余空行", () => {
    expect(mergeQueued([item("  "), item("有内容")]).text).toBe("有内容");
  });
});

describe("sliceQueue 斜杠命令独占一帧", () => {
  const item = (text: string, btw = false) => parseQueued(btw ? `/btw ${text}` : text, []);
  const texts = (l: { text: string }[]) => l.map((i) => i.text);

  test("没有命令时整队一次发完", () => {
    const { batch, rest } = sliceQueue([item("先做A"), item("再做B")]);
    expect(texts(batch)).toEqual(["先做A", "再做B"]);
    expect(rest).toEqual([]);
  });

  test("队首是命令：只发它，其余留队列", () => {
    const { batch, rest } = sliceQueue([item("/compact"), item("继续")]);
    expect(texts(batch)).toEqual(["/compact"]);
    expect(texts(rest)).toEqual(["继续"]);
  });

  test("命令在中间：先发它前面的，命令留到下一轮", () => {
    const { batch, rest } = sliceQueue([item("先做A"), item("/compact"), item("再做B")]);
    expect(texts(batch)).toEqual(["先做A"]);
    expect(texts(rest)).toEqual(["/compact", "再做B"]);
  });

  test("/btw 去前缀后剩的正文即使像路径也不当命令", () => {
    const { batch, rest } = sliceQueue([parseQueued("/btw /etc 下那个配置", [])]);
    expect(texts(batch)).toEqual(["/etc 下那个配置"]);
    expect(rest).toEqual([]);
  });

  test("空队列不炸", () => {
    expect(sliceQueue([])).toEqual({ batch: [], rest: [] });
  });
});
