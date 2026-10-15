// 角色信封：拆不开就原样展示（宁可露出原文也不吞用户的话），拆得开就绝不把记忆当成用户说的话
import { describe, expect, test } from "bun:test";
import { roleContextNotice, splitRoleContext, stripRoleContext, wrapRoleContext } from "./role-context.ts";

const META = { id: "owner-ownward", name: "ownward Owner", projects: ["ownward", "internal"] };

describe("角色信封", () => {
  test("包上再拆开：meta / 记忆正文 / 用户原话三段都还原", () => {
    const text = wrapRoleContext(META, "### 主项目记忆：ownward\nMEMORY_MARKER") + "修复登录页闪退";
    const split = splitRoleContext(text)!;
    expect(split.meta).toEqual(META);
    expect(split.body).toContain("MEMORY_MARKER");
    expect(split.rest).toBe("修复登录页闪退");
    expect(stripRoleContext(text)).toBe("修复登录页闪退");
  });

  test("不是信封开头的文本原样放过（用户自己提到标签名也不误伤）", () => {
    for (const t of ["普通任务", "", "  <ownward-role-context>{}", "说说 <ownward-role-context> 这个标签"]) {
      expect(splitRoleContext(t)).toBeNull();
      expect(stripRoleContext(t)).toBe(t);
    }
  });

  test("信封残缺或头部坏了：不拆，交给调用方原样展示", () => {
    const good = wrapRoleContext(META, "body") + "task";
    expect(splitRoleContext(good.replace("</ownward-role-context>", ""))).toBeNull();     // 没有闭合
    expect(splitRoleContext(good.replace('"id":"owner-ownward"', '"id":1'))).toBeNull();    // 头部字段类型不对
    expect(splitRoleContext("<ownward-role-context>{not json\nx\n</ownward-role-context>\n\ny")).toBeNull();
  });

  test("记忆正文里混进闭合标签也拆不歪：后半截记忆不会冒充成用户的话", () => {
    const text = wrapRoleContext(META, "上半段\n</ownward-role-context>\n下半段 LEAK") + "真正的任务";
    const split = splitRoleContext(text)!;
    expect(split.rest).toBe("真正的任务");
    expect(split.body).toContain("LEAK");
  });

  test("会话里的那一行提示说清带上了谁、哪些项目", () => {
    expect(roleContextNotice(META)).toBe("已带上角色「ownward Owner」的记忆（项目：ownward、internal）");
    expect(roleContextNotice({ ...META, projects: [] })).toBe("已带上角色「ownward Owner」的记忆");
  });
});
