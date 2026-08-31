package ai.ownward.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatProviderSelectionTest {
    @Test fun emptyProvidersFail() {
        val error = runCatching { selectChatProvider(emptyMap(), "codex", "default", false) }.exceptionOrNull()
        assertTrue(error?.message?.contains("没有可用") == true)
    }

    @Test fun newChatFallsBackToFirstAvailableProvider() {
        val selected = selectChatProvider(
            linkedMapOf("codex" to emptyList(), "claude" to listOf("sonnet")),
            "codex", "default", false,
        )
        assertEquals(mapOf("claude" to listOf("sonnet")), selected.providers)
        assertEquals("claude", selected.provider)
        assertEquals("sonnet", selected.model)
    }

    @Test fun existingUnavailableModelFails() {
        val error = runCatching {
            selectChatProvider(mapOf("codex" to listOf("new")), "codex", "old", true)
        }.exceptionOrNull()
        assertTrue(error?.message?.contains("当前不可用") == true)
    }

    @Test fun defaultSentinelReopensExistingChatButNewChatUsesFirstExplicitModel() {
        val providers = linkedMapOf(
            "codex" to listOf("gpt-5.6-sol", "gpt-5.6-terra", "default"),
            "claude" to listOf("sonnet", "default"),
        )

        val existing = selectChatProvider(providers, "codex", "default", existingChat = true)
        assertEquals("codex", existing.provider)
        assertEquals("default", existing.model)

        val fresh = selectChatProvider(providers, "codex", "default", existingChat = false)
        assertEquals("codex", fresh.provider)
        assertEquals("gpt-5.6-sol", fresh.model)
    }
}
