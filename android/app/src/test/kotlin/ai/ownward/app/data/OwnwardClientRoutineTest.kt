package ai.ownward.app.data

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test

class OwnwardClientRoutineTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OwnwardClient

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
        client = OwnwardClient(server.url("/").toString(), "")
    }

    @After fun tearDown() = server.shutdown()

    @Test fun draftGetEncodesOccurrenceIdentity() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"ok":true,"draft":"正文","status":"draft","stale":false}"""))
        assertEquals("正文", client.routineDraft("周 报/研发", "2026-08-27+08").draft)
        assertEquals("/api/routines/draft?id=%E5%91%A8+%E6%8A%A5%2F%E7%A0%94%E5%8F%91&date=2026-08-27%2B08", server.takeRequest().path)
    }

    @Test fun savePostsDateAndEditedContent() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"ok":true,"msg":"已保存"}"""))
        client.routineSaveDraft("daily", "2026-08-27", "修改后\n正文")
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/routines/draft", request.path)
        assertEquals("""{"id":"daily","date":"2026-08-27","content":"修改后\n正文"}""", request.body.readUtf8())
    }

    @Test fun okFalseAndHttpFailureAreBothVisibleAsExceptions() {
        server.enqueue(MockResponse().setBody("""{"ok":false,"msg":"保存被拒绝"}"""))
        val logical = assertThrows(ApiException::class.java) { runBlocking { client.routineSaveDraft("x", "d", "c") } }
        assertEquals("保存被拒绝", logical.message)

        server.enqueue(MockResponse().setResponseCode(404).setBody("""{"ok":false,"msg":"没有草稿"}"""))
        val http = assertThrows(ApiException::class.java) { runBlocking { client.routineDraft("x", "d") } }
        assertEquals("没有草稿", http.message)
    }
}
