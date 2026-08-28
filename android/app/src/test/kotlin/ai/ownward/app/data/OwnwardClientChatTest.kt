package ai.ownward.app.data

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class OwnwardClientChatTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OwnwardClient

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
        client = OwnwardClient(server.url("/").toString(), "")
    }

    @After fun tearDown() = server.shutdown()

    private fun enqueue(vararg lines: String) {
        server.enqueue(MockResponse().setBody(lines.joinToString("\n", postfix = "\n")))
    }

    private fun collect() = runBlocking {
        client.chatSend(null, "hello", "codex", "gpt").toList()
    }

    private fun doneJson() = """{"type":"done","chat":{"id":"c1","title":"Hi","provider":"codex","model":"gpt","messages":[],"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}}"""

    @Test fun deltaThenDone() {
        enqueue("""{"type":"delta","text":"hi"}""", doneJson())
        val events = collect()
        assertEquals(ChatEvent.Delta("hi"), events[0])
        assertTrue(events[1] is ChatEvent.Done)
        assertEquals("c1", (events[1] as ChatEvent.Done).chat.id)
    }

    @Test fun errorStopsStream() {
        enqueue("""{"type":"error","msg":"boom"}""", doneJson())
        assertEquals(listOf(ChatEvent.Error("boom")), collect())
    }

    @Test fun malformedJsonIsSkipped() {
        // 坏行跳过、不杀流（前向兼容，对齐 web）：坏行后面的 done 仍能正常收到
        enqueue("not-json", doneJson())
        val events = collect()
        assertEquals(1, events.size)
        assertTrue(events[0] is ChatEvent.Done)
    }

    @Test fun unknownEventIsSkipped() {
        // 未知帧跳过：服务端加新事件类型不该杀掉老客户端的流
        enqueue("""{"type":"mystery"}""", doneJson())
        val events = collect()
        assertEquals(1, events.size)
        assertTrue(events[0] is ChatEvent.Done)
    }

    @Test fun doneWithoutChatThrows() = assertFailsWithMessage("对话完成帧缺少会话数据") {
        enqueue("""{"type":"done"}""")
        collect()
    }

    @Test fun cleanEofCompletesWithoutDone() {
        enqueue("""{"type":"delta","text":"partial"}""")
        val events = collect()
        assertEquals(listOf(ChatEvent.Delta("partial")), events)
        assertFalse(events.any { it is ChatEvent.Done })
    }

    private fun assertFailsWithMessage(message: String, block: () -> Unit) {
        val error = runCatching(block).exceptionOrNull()
        assertTrue("expected failure", error != null)
        assertTrue("actual message: ${error?.message}", error?.message?.contains(message) == true)
    }
}
