"use strict";
/* 会话流的折叠规则。只有纯逻辑、不碰 DOM——渲染在 tasks.js，这里只管「怎么分组」，
   好让 src/web-feed.test.ts 能直接把这个文件当函数跑起来测。
   规则与安卓 android/app/src/main/kotlin/ai/ownward/app/ui/Feed.kt 逐条对齐：
   两端折法不一样，等于同一个会话在手机和电脑上是两个事实。改一处必须改两处，两边都有测试盯着。 */

/**
 * 把连续的工具调用折成一组。
 *
 * 为什么折：一轮任务动辄几十次 Edit/Bash/Read，一条一行能把整屏刷满，
 * 而这段时间真正想知道的只有三件事——还在跑吗、跑到第几步、有没有出错。
 * 路径和参数是要用时才展开的东西，不是默认要占屏幕的东西。
 *
 * 少于 minRun 条不折：两三行本来就不碍事，折起来反而多一次点击。
 * 图片行（agent 的截图/读图）是内容不是过程，遇到就断组——宁可多分一组，
 * 也不为了折得整齐去重排消息顺序：顺序被动过的流，看的人没法信任。
 *
 * 返回项要么是 {index, msg}（单条），要么是 {index, msgs}（一组）。index 是它在原列表里的
 * 正序起点，用作展开状态的 key：组会一直长大但起点不动，重渲染时展开态不会跳。
 * 两条不变量（有测试盯着）：index 唯一且严格递增；逐项展开还原就是原列表。
 */
function foldToolRuns(msgs, minRun = 3) {
  const foldable = (i) => msgs[i].role === "tool" && msgs[i].name !== "image";
  const out = [];
  for (let i = 0; i < msgs.length;) {
    if (!foldable(i)) { out.push({ index: i, msg: msgs[i] }); i++; continue; }
    let j = i + 1;
    while (j < msgs.length && foldable(j)) j++;
    if (j - i >= minRun) out.push({ index: i, msgs: msgs.slice(i, j) });
    else for (let k = i; k < j; k++) out.push({ index: k, msg: msgs[k] });
    i = j;
  }
  return out;
}

/** ⚠️ 出错 / ⛔ 已拒绝：服务端用这两个前缀标失败的工具行（agent-session.ts、runner-consumer.ts） */
const isToolError = (m) => /^(⚠️|⛔)/.test(m.name || "");

/** 折叠组收起时的副标题：还在跑显示当前这条（一眼看出卡在哪），跑完了显示这段都干了什么 */
function toolRunSubtitle(msgs, live) {
  if (!msgs.length) return "";
  if (live) {
    const last = msgs[msgs.length - 1];
    return `${last.name || "tool"} ${(last.text || "").split("\n")[0]}`.trim();
  }
  const counts = new Map();
  for (const m of msgs) if (!isToolError(m)) counts.set(m.name || "tool", (counts.get(m.name || "tool") || 0) + 1);
  const kinds = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return kinds.slice(0, 3).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(" · ") + (kinds.length > 3 ? " …" : "");
}
