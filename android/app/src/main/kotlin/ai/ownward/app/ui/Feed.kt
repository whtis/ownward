package ai.ownward.app.ui

import ai.ownward.app.data.DevMsg

// 会话流的折叠规则。纯逻辑、不碰 Compose——渲染在 Components.kt，这里只管「怎么分组」，
// 好让它能在 JVM 上直接测（分组错了会当场炸 LazyColumn 的 key 唯一性，肉眼看不出来）。

/**
 * 会话流的一项：一条普通消息，或一段被折叠起来的连续工具调用。
 * index 是它在原始 messages 里的正序起点下标——LazyColumn 的 key 用它：
 * 尾部那组会一直长大，但起点不动，增量追加时旧项不换位。
 */
sealed interface FeedItem {
    val index: Int
    data class One(override val index: Int, val msg: DevMsg) : FeedItem
    data class Tools(override val index: Int, val msgs: List<DevMsg>) : FeedItem
}

/**
 * 把连续的工具调用折成一组。
 *
 * 为什么折：一轮任务动辄几十次 Edit/Bash/Read，一条一行能把整屏刷满，
 * 而这段时间用户真正想知道的只有三件事——还在跑吗、跑到第几步、有没有出错。
 * 路径和参数是要用的时候才展开的东西，不是默认要占屏幕的东西。
 *
 * 少于 minRun 条不折：两三行本来就不碍事，折起来反而多一次点击。
 * 图片行（agent 的截图/读图）不折也不进组，它是内容不是过程——夹在中间就把这段执行断开，
 * 宁可多分一组，也不把消息顺序重排：顺序被动过的流，看的人没法信任。
 *
 * 两条不变量（有测试盯着）：每一项的 index 唯一且严格递增；展开后逐条还原就是原列表。
 */
fun foldToolRuns(msgs: List<DevMsg>, minRun: Int = 3): List<FeedItem> {
    fun foldable(i: Int) = msgs[i].role == "tool" && msgs[i].name != "image"
    val out = ArrayList<FeedItem>(msgs.size)
    var i = 0
    while (i < msgs.size) {
        if (!foldable(i)) { out.add(FeedItem.One(i, msgs[i])); i++; continue }
        var j = i + 1
        while (j < msgs.size && foldable(j)) j++
        if (j - i >= minRun) out.add(FeedItem.Tools(i, msgs.subList(i, j).toList()))
        else for (k in i until j) out.add(FeedItem.One(k, msgs[k]))
        i = j
    }
    return out
}

/** ⚠️ 出错 / ⛔ 已拒绝：服务端用这两个前缀标失败的工具行（agent-session.ts、runner-consumer.ts） */
fun DevMsg.isToolError() = name?.let { it.startsWith("⚠️") || it.startsWith("⛔") } == true

/** 显示用的工具名：空名一律当 "tool"，口径必须和 web/feed.js 的 `m.name || "tool"` 一字不差 */
fun DevMsg.toolLabel() = name?.takeIf { it.isNotBlank() } ?: "tool"

/**
 * 折叠组收起时的副标题。
 * 还在跑就显示当前这条（一眼看出卡在哪）；跑完了显示这段都干了什么，按次数取前 3 类。
 */
fun toolRunSubtitle(msgs: List<DevMsg>, live: Boolean): String {
    if (msgs.isEmpty()) return ""
    if (live) {
        val last = msgs.last()
        return "${last.toolLabel()} ${last.text.lineSequence().firstOrNull().orEmpty()}".trim()
    }
    // 次数降序；并列时保持首次出现的顺序（sortedByDescending 是稳定排序，JS 的 Array#sort 同样稳定）
    val kinds = msgs.filterNot { it.isToolError() }.groupingBy { it.toolLabel() }.eachCount()
        .entries.sortedByDescending { it.value }
    return kinds.take(3).joinToString(" · ") { if (it.value > 1) "${it.key} ×${it.value}" else it.key } +
        if (kinds.size > 3) " …" else ""
}
