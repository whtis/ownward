package ai.ownward.app.ui

import ai.ownward.app.data.DevMsg
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private fun tool(name: String, text: String = "") = DevMsg(role = "tool", name = name, text = text)
private fun user(text: String) = DevMsg(role = "user", text = text)
private fun assistant(text: String) = DevMsg(role = "assistant", text = text)
private fun image() = DevMsg(role = "tool", name = "image", text = "🖼 图片 ×1")

/** 展开每一项，还原成原来的消息序列——折叠不能丢消息也不能改顺序 */
private fun flatten(feed: List<FeedItem>) = feed.flatMap {
    when (it) {
        is FeedItem.One -> listOf(it.msg)
        is FeedItem.Tools -> it.msgs
    }
}

class FeedTest {
    @Test
    fun `连续工具调用折成一组，非工具消息原样保留`() {
        val msgs = listOf(
            user("开工"),
            tool("Edit", "src/a.ts"), tool("Bash", "bun test"), tool("Read", "src/b.ts"), tool("Edit", "src/c.ts"),
            assistant("做完了"),
        )
        val feed = foldToolRuns(msgs)
        assertEquals(3, feed.size)
        assertTrue(feed[0] is FeedItem.One)
        assertEquals(4, (feed[1] as FeedItem.Tools).msgs.size)
        assertTrue(feed[2] is FeedItem.One)
        assertEquals(msgs, flatten(feed))
    }

    @Test
    fun `不到 minRun 条不折——两行本来就不碍事，折起来反而多一次点击`() {
        val msgs = listOf(user("嗨"), tool("Bash", "git status"), tool("Read", "a.ts"), assistant("好"))
        val feed = foldToolRuns(msgs)
        assertTrue(feed.none { it is FeedItem.Tools })
        assertEquals(4, feed.size)
        assertEquals(msgs, flatten(feed))
    }

    @Test
    fun `图片行断开一段执行，且顺序原样不动`() {
        val msgs = listOf(
            tool("Read", "1"), tool("Read", "2"), tool("Read", "3"),
            image(),
            tool("Edit", "4"), tool("Edit", "5"), tool("Edit", "6"),
        )
        val feed = foldToolRuns(msgs)
        assertEquals(3, feed.size)
        assertEquals(3, (feed[0] as FeedItem.Tools).msgs.size)
        assertEquals("image", (feed[1] as FeedItem.One).msg.name)
        assertEquals(3, (feed[2] as FeedItem.Tools).msgs.size)
        assertEquals(msgs, flatten(feed)) // 图片没有被挪到组后面
    }

    @Test
    fun `index 唯一且递增——重复 key 会当场炸 LazyColumn`() {
        val msgs = listOf(
            user("a"),
            tool("Bash", "1"), tool("Bash", "2"),                 // 短跑：拆成两条 One，index 不能撞
            assistant("b"),
            tool("Edit", "3"), tool("Edit", "4"), tool("Edit", "5"),
            image(),
            tool("Read", "6"),
            user("c"),
        )
        val keys = foldToolRuns(msgs).map { it.index }
        assertEquals(keys.size, keys.toSet().size)
        assertEquals(keys.sorted(), keys)
        assertEquals(msgs, flatten(foldToolRuns(msgs)))
    }

    @Test
    fun `组的 index 是起点——尾部那组变长时 key 不变`() {
        val head = listOf(user("开工"), tool("Edit", "1"), tool("Edit", "2"), tool("Edit", "3"))
        val grown = head + listOf(tool("Edit", "4"), tool("Bash", "5"))
        assertEquals(foldToolRuns(head).map { it.index }, foldToolRuns(grown).map { it.index })
    }

    @Test
    fun `收起时的副标题：跑完看类型汇总，还在跑看当前这条`() {
        val msgs = listOf(
            tool("Edit", "a"), tool("Edit", "b"), tool("Bash", "bun test"),
            tool("⚠️ 出错", "boom"), tool("Read", "c"),
        )
        // 汇总按次数降序；出错不混进类型汇总（它单独在标题上标红计数）
        assertEquals("Edit ×2 · Bash · Read", toolRunSubtitle(msgs, live = false))
        // 还在跑：显示最后一条，且只取首行——工具输出可能是多行的
        assertEquals("Bash bun test", toolRunSubtitle(listOf(tool("Bash", "bun test\n3 pass")), live = true))
    }

    @Test
    fun `超过 3 类会带省略号，不把标题撑爆`() {
        val msgs = listOf(tool("Edit"), tool("Bash"), tool("Read"), tool("Grep"))
        assertTrue(toolRunSubtitle(msgs, live = false).endsWith(" …"))
    }

    @Test
    fun `出错行认得出来——折叠可以省过程，不能把失败一起藏了`() {
        assertTrue(tool("⚠️ 出错", "boom").isToolError())
        assertTrue(tool("⛔ 已拒绝", "denied").isToolError())
        assertTrue(!tool("Edit", "a.ts").isToolError())
    }

    @Test
    // 与 web-feed.test.ts 同名用例配对：Kotlin 的 elvis 只挡 null，JS 的 || 连空串一起挡，不显式钉住就会漂
    fun `空工具名当 tool——两端口径必须一致`() {
        assertEquals("tool", toolRunSubtitle(listOf(tool("", "做点什么")), live = true).substringBefore(" "))
        assertEquals("tool ×2", toolRunSubtitle(listOf(tool(""), tool("")), live = false))
    }

    @Test
    fun `空列表不炸`() {
        assertEquals(emptyList<FeedItem>(), foldToolRuns(emptyList()))
        assertEquals("", toolRunSubtitle(emptyList(), live = true))
    }
}
