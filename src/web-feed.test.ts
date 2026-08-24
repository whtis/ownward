// web/feed.js 的单测：会话流的工具调用折叠规则。
//
// 这份预期和安卓 android/app/src/test/.../FeedTest.kt 是同一张表——两端各写一份实现，
// 唯一能防止它们漂移成两种行为的就是两边用同一份预期。改规则时两个测试文件一起改，
// 只改一边就会有一边挂：那正是要的效果。
//
// feed.js 是浏览器里的普通 <script>（没有 export），所以这里读源码当函数体跑起来取里面的符号。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const src = readFileSync(join(import.meta.dir, "..", "web", "feed.js"), "utf8");
const { foldToolRuns, isToolError, toolRunSubtitle } = new Function(
  `${src}\nreturn { foldToolRuns, isToolError, toolRunSubtitle };`,
)() as {
  foldToolRuns: (msgs: any[], minRun?: number) => any[];
  isToolError: (m: any) => boolean;
  toolRunSubtitle: (msgs: any[], live: boolean) => string;
};

const tool = (name: string, text = "") => ({ role: "tool", name, text });
const user = (text: string) => ({ role: "user", text });
const assistant = (text: string) => ({ role: "assistant", text });
const image = () => ({ role: "tool", name: "image", text: "🖼 图片 ×1" });

/** 逐项展开还原成原来的消息序列——折叠不能丢消息也不能改顺序 */
const flatten = (feed: any[]) => feed.flatMap((it) => (it.msgs ? it.msgs : [it.msg]));

describe("foldToolRuns", () => {
  test("连续工具调用折成一组，非工具消息原样保留", () => {
    const msgs = [
      user("开工"),
      tool("Edit", "src/a.ts"), tool("Bash", "bun test"), tool("Read", "src/b.ts"), tool("Edit", "src/c.ts"),
      assistant("做完了"),
    ];
    const feed = foldToolRuns(msgs);
    expect(feed.length).toBe(3);
    expect(feed[0].msg).toBe(msgs[0]);
    expect(feed[1].msgs.length).toBe(4);
    expect(feed[2].msg).toBe(msgs[5]);
    expect(flatten(feed)).toEqual(msgs);
  });

  test("不到 minRun 条不折——两行本来就不碍事，折起来反而多一次点击", () => {
    const msgs = [user("嗨"), tool("Bash", "git status"), tool("Read", "a.ts"), assistant("好")];
    const feed = foldToolRuns(msgs);
    expect(feed.some((it) => it.msgs)).toBe(false);
    expect(feed.length).toBe(4);
    expect(flatten(feed)).toEqual(msgs);
  });

  test("图片行断开一段执行，且顺序原样不动", () => {
    const msgs = [
      tool("Read", "1"), tool("Read", "2"), tool("Read", "3"),
      image(),
      tool("Edit", "4"), tool("Edit", "5"), tool("Edit", "6"),
    ];
    const feed = foldToolRuns(msgs);
    expect(feed.length).toBe(3);
    expect(feed[0].msgs.length).toBe(3);
    expect(feed[1].msg.name).toBe("image");
    expect(feed[2].msgs.length).toBe(3);
    expect(flatten(feed)).toEqual(msgs); // 图片没有被挪到组后面
  });

  test("index 唯一且递增——重复 key 会让展开态串到别人身上", () => {
    const msgs = [
      user("a"),
      tool("Bash", "1"), tool("Bash", "2"),                 // 短跑：拆成两条单项，index 不能撞
      assistant("b"),
      tool("Edit", "3"), tool("Edit", "4"), tool("Edit", "5"),
      image(),
      tool("Read", "6"),
      user("c"),
    ];
    const keys = foldToolRuns(msgs).map((it) => it.index);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort((a, b) => a - b)).toEqual(keys);
    expect(flatten(foldToolRuns(msgs))).toEqual(msgs);
  });

  test("组的 index 是起点——尾部那组变长时 key 不变", () => {
    const head = [user("开工"), tool("Edit", "1"), tool("Edit", "2"), tool("Edit", "3")];
    const grown = [...head, tool("Edit", "4"), tool("Bash", "5")];
    expect(foldToolRuns(grown).map((it) => it.index)).toEqual(foldToolRuns(head).map((it) => it.index));
  });

  test("空列表不炸", () => {
    expect(foldToolRuns([])).toEqual([]);
    expect(toolRunSubtitle([], true)).toBe("");
  });
});

describe("toolRunSubtitle", () => {
  test("跑完看类型汇总（按次数降序），还在跑看当前这条", () => {
    const msgs = [
      tool("Edit", "a"), tool("Edit", "b"), tool("Bash", "bun test"),
      tool("⚠️ 出错", "boom"), tool("Read", "c"),
    ];
    // 出错不混进类型汇总——它单独在标题上标红计数
    expect(toolRunSubtitle(msgs, false)).toBe("Edit ×2 · Bash · Read");
    // 还在跑：显示最后一条，且只取首行（工具输出可能是多行的）
    expect(toolRunSubtitle([tool("Bash", "bun test\n3 pass")], true)).toBe("Bash bun test");
  });

  // 与 FeedTest.kt 同名用例配对：Kotlin 的 ?: 只挡 null，JS 的 || 连空串一起挡，不显式钉住就会漂
  test("空工具名当 tool——两端口径必须一致", () => {
    expect(toolRunSubtitle([tool("", "做点什么")], true).split(" ")[0]).toBe("tool");
    expect(toolRunSubtitle([tool(""), tool("")], false)).toBe("tool ×2");
  });

  test("超过 3 类会带省略号，不把标题撑爆", () => {
    const msgs = [tool("Edit"), tool("Bash"), tool("Read"), tool("Grep")];
    expect(toolRunSubtitle(msgs, false).endsWith(" …")).toBe(true);
  });
});

describe("isToolError", () => {
  test("认得出失败的工具行——折叠可以省过程，不能把失败一起藏了", () => {
    expect(isToolError(tool("⚠️ 出错", "boom"))).toBe(true);
    expect(isToolError(tool("⛔ 已拒绝", "denied"))).toBe(true);
    expect(isToolError(tool("Edit", "a.ts"))).toBe(false);
  });
});
