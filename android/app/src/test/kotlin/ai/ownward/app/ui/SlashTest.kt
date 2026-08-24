package ai.ownward.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 与 ios SlashTests.swift 逐条配对：补全口径三端必须一致，各写各的迟早漂成三种行为 */
class SlashTest {
    @Test
    fun `整条是斜杠开头的词才提示——打了空格就不弹了`() {
        assertEquals("", Slash.query("/"))
        assertEquals("comp", Slash.query("/comp"))
        assertNull(Slash.query("/compact "))          // 空格 = 命令已选定，开始写参数
        assertNull(Slash.query("/btw 顺便看下 README"))
        assertNull(Slash.query("看下 /etc 配置"))      // 不在开头不算
        assertNull(Slash.query(""))
    }

    @Test
    fun `候选表：本地命令在前，服务端同名不重复`() {
        assertEquals(
            listOf("new", "clear", "btw", "compact", "resume"),
            Slash.all(listOf("compact", "new", "resume"))?.map { it.name },
        )
        // 同名以本地的说明为准
        assertEquals("同任务丢上下文重开", Slash.all(listOf("new"))?.first()?.desc)
        assertNull(Slash.all(null))                   // null = 这个输入框不该有补全
    }

    @Test
    fun `前缀命中排在包含命中前面`() {
        assertEquals(
            listOf("clear", "compact", "context"),
            Slash.matches("/c", listOf("compact", "context")).map { it.name },
        )
        // 包含即命中：ea 只在 clear 里
        assertEquals(listOf("clear"), Slash.matches("/ea", emptyList()).map { it.name })
    }

    @Test
    // 对面 Swift 的 String.contains("") 返回 false（走 range(of:)），照抄会让「打完 / 一条不弹」；
    // Kotlin 的 contains("") 是 true，两端都得钉住这条
    fun `只打一个斜杠时全表都算命中`() {
        assertEquals(listOf("btw", "clear", "new"), Slash.matches("/", emptyList()).map { it.name })
    }

    @Test
    fun `不该弹菜单的时候一条都不给`() {
        assertTrue(Slash.matches("你好", emptyList()).isEmpty())
        assertTrue(Slash.matches("/new", null).isEmpty())    // commands 为 null：整个功能关掉
        assertTrue(Slash.matches("/zzzz", emptyList()).isEmpty())
    }

    @Test
    fun `选中一条就换成整条命令并留个空格接参数`() {
        assertEquals("/compact ", Slash.accept(SlashCmd("compact", "")))
    }

    @Test
    fun `最多 40 条——不把菜单撑到看不完`() {
        assertEquals(40, Slash.matches("/cmd", (0 until 200).map { "cmd$it" }).size)
    }
}
