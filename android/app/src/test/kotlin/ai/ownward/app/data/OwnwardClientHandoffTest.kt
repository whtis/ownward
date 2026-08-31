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

    @Test fun reconfigurePostsProviderModelAndEffort() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"ok":true,"msg":"ok"}"""))

        client.devHandoff(
            id = "task 1",
            providerId = "codex",
            model = "gpt-5.6-sol",
            effort = "xhigh",
            reason = "manual-reconfigure",
        )

        assertEquals(
            """{"id":"task 1","providerId":"codex","model":"gpt-5.6-sol","effort":"xhigh","reason":"manual-reconfigure","confirmUnknownOutcome":false}""",
            server.takeRequest().body.readUtf8(),
        )
    }

    @Test fun reconfigureOmitsProviderDefaultSentinels() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"ok":true,"msg":"ok"}"""))

        client.devHandoff(
            id = "task 1",
            providerId = "codex",
            model = "",
            effort = "high",
            reason = "manual-reconfigure",
        )

        assertEquals(
            """{"id":"task 1","providerId":"codex","effort":"high","reason":"manual-reconfigure","confirmUnknownOutcome":false}""",
            server.takeRequest().body.readUtf8(),
        )
    }

    @Test fun dispatchPostsSelectedEffort() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"ok":true,"msg":"ok"}"""))

        client.dispatchWork(
            dir = "/repo",
            task = "work",
            provider = "codex",
            worktree = true,
            model = "gpt-5.6-sol",
            effort = "ultra",
            permission = "safe",
        )

        assertEquals(
            """{"dir":"/repo","task":"work","bg":true,"provider":"codex","worktree":true,"model":"gpt-5.6-sol","effort":"ultra","permission":"safe"}""",
            server.takeRequest().body.readUtf8(),
        )
    }
}
