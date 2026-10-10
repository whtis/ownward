import { describe, expect, test } from "bun:test";
import { parseMessageTail, tailMessages } from "./message-tail.ts";

describe("message tail", () => {
  test("缺省全量；非负整数才合法", () => {
    expect(parseMessageTail(null)).toBeUndefined();
    expect(parseMessageTail("")).toBeUndefined();
    expect(parseMessageTail("0")).toBe(0);
    expect(parseMessageTail("400")).toBe(400);
    for (const bad of ["-1", "1.5", "abc", "1e3", "99999999"]) expect(parseMessageTail(bad)).toBeNull();
  });

  test("只留最后 N 条并报告省了几条；tail=0 只要元数据", () => {
    const state = { turn: "idle", messages: [1, 2, 3, 4, 5] };
    expect(tailMessages(state, 2)).toEqual({ turn: "idle", messages: [4, 5], omitted: 3 });
    expect(tailMessages(state, 10)).toEqual({ turn: "idle", messages: [1, 2, 3, 4, 5], omitted: 0 });
    expect(tailMessages(state, 0)).toEqual({ turn: "idle", messages: [], omitted: 5 });
    expect(tailMessages(state, undefined)).toBe(state);
    expect(state.messages).toEqual([1, 2, 3, 4, 5]);   // 不改原对象
  });
});
