package ai.ownward.app.ui

import ai.ownward.app.data.RoutineCard
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RoutineReviewTest {
    @Test fun onlyDraftIsEditable() {
        assertTrue(routineCanEdit("draft"))
        listOf("writing", "written", "skipped", "pending", "upcoming").forEach {
            assertFalse(it, routineCanEdit(it))
        }
    }

    @Test fun submitRequiresSuccessfulLoadAndDraftStatus() {
        assertFalse(routineCanSubmit("draft", loadedSuccessfully = false))
        assertFalse(routineCanSubmit("written", loadedSuccessfully = true))
        assertFalse(routineCanSubmit("skipped", loadedSuccessfully = true))
        assertTrue(routineCanSubmit("draft", loadedSuccessfully = true))
    }

    @Test fun actionsMatchRoutineState() {
        assertEquals(setOf("generate"), routineActions(card("pending")))
        assertEquals(setOf("view", "skip"), routineActions(card("draft", hasDraft = true)))
        assertEquals(setOf("view", "task"), routineActions(card("writing", hasDraft = true, taskId = "t")))
        assertEquals(setOf("view"), routineActions(card("written", hasDraft = true)))
        assertEquals(setOf("view"), routineActions(card("skipped", hasDraft = true)))
        assertEquals(setOf("document"), routineActions(card("upcoming", docUrl = "https://example.com")))
    }

    @Test fun saveFailureNeverStartsWrite() {
        var writes = 0
        runCatching {
            runBlocking {
                saveThenWrite(save = { error("保存失败") }, write = { writes++ })
            }
        }
        assertEquals(0, writes)
    }

    private fun card(
        status: String,
        hasDraft: Boolean = false,
        taskId: String? = null,
        docUrl: String? = null,
    ) = RoutineCard(id = "r", status = status, hasDraft = hasDraft, taskId = taskId, docUrl = docUrl)
}
