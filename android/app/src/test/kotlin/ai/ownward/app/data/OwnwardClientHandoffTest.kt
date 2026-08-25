package ai.ownward.app.data

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

class OwnwardClientHandoffTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OwnwardClient

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
        client = OwnwardClient(server.url("/").toString(), "")
    }

    @After fun tearDown() = server.shutdown()

    @Test fun handoffPostsProviderAndManualReason() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"ok":true,"msg":"ok"}"""))

        client.devHandoff("task 1", "codex", false)

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/api/dev/handoff", request.path)
        assertEquals(
            """{"id":"task 1","providerId":"codex","reason":"manual","confirmUnknownOutcome":false}""",
            request.body.readUtf8(),
        )
    }

    @Test fun confirmedUnknownOutcomeIsExplicitlyPosted() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"ok":true,"msg":"ok"}"""))
        client.devHandoff("task 1", "claude", true)
        assertEquals(
            """{"id":"task 1","providerId":"claude","reason":"manual","confirmUnknownOutcome":true}""",
            server.takeRequest().body.readUtf8(),
        )
    }
}
