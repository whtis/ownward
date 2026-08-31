package ai.ownward.app.ui

import ai.ownward.app.data.AgentState
import ai.ownward.app.data.AppJson
import ai.ownward.app.data.ApiException
import ai.ownward.app.data.PendingPerm
import ai.ownward.app.data.QueuedView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HandoffTest {
    @Test fun idleOwnedSessionCanHandoff() {
        assertNull(handoffBlockReason(AgentState(backend = "claude")))
    }

    @Test fun busyStatesExplainWhyHandoffIsBlocked() {
        assertEquals("当前轮次运行中，请等待结束或先中断", handoffBlockReason(AgentState(turn = "running")))
        assertEquals("有待处理的审批，请先确认", handoffBlockReason(AgentState(pending = listOf(PendingPerm("p")))))
        assertEquals("有排队消息，请先等待发送或撤回", handoffBlockReason(AgentState(queued = listOf(QueuedView(id = "q")))))
        assertEquals("仅 ownward 持有输入权时可切换", handoffBlockReason(AgentState(control = "external")))
    }

    @Test fun engineLabelPrefersProviderThenBackendAndSupportsOldDaemon() {
        assertEquals("codebuddy", engineLabel("claude-bg", backend = "claude", providerId = "codebuddy"))
        assertEquals("codebuddy", engineLabel("claude-bg", backend = "codebuddy"))
        assertEquals("codebuddy", engineLabel("codebuddy-bg"))
        assertEquals("claude", engineLabel("claude-bg"))
    }

    @Test fun onlyUnknownOutcomePolicyErrorRequestsStrongConfirmation() {
        assertEquals(true, needsUnknownHandoffConfirmation(ApiException(400, "confirm", "SESSION_HANDOFF_UNKNOWN_CONFIRM_REQUIRED")))
        assertEquals(false, needsUnknownHandoffConfirmation(ApiException(400, "other", "SESSION_BUSY")))
        assertEquals(false, needsUnknownHandoffConfirmation(IllegalStateException("SESSION_HANDOFF_UNKNOWN_CONFIRM_REQUIRED")))
    }

    @Test fun sessionCapabilitiesMatchExactModelSpecificContract() {
        assertEquals(
            linkedMapOf(
                "gpt-5.6-sol" to listOf("low", "medium", "high", "xhigh", "max", "ultra"),
                "gpt-5.6-terra" to listOf("low", "medium", "high", "xhigh", "max", "ultra"),
                "gpt-5.6-luna" to listOf("low", "medium", "high", "xhigh", "max"),
                "gpt-5.5" to listOf("low", "medium", "high", "xhigh"),
                "gpt-5.4" to listOf("low", "medium", "high", "xhigh"),
            ),
            WORK_CODEX_MODEL_EFFORTS,
        )
        assertEquals(listOf("low", "medium", "high", "xhigh", "max"), workProviderEfforts("claude", "sonnet"))
        assertEquals(workProviderEfforts("claude", "sonnet"), workProviderEfforts("codebuddy", "hy3"))
        assertEquals(emptyList<String>(), workProviderEfforts("codex", "gpt-5.5-pro"))
        assertEquals("gpt-5.6-sol", workProviderDefaultModel("codex"))
        assertEquals("gpt-5.6-sol", workProviderHandoffModel("codex"))
    }

    @Test fun defaultServerModelListStillExposesAllKnownTaskModels() {
        assertEquals(
            listOf("gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"),
            workProviderModels("codex", mapOf("codex" to listOf("gpt-5.6-sol"))),
        )
    }

    @Test fun modelChangesChooseSupportedDefaultAndLegacyPairsCannotSubmit() {
        assertEquals("medium", workProviderDefaultEffort("codex", "gpt-5.4"))
        assertEquals(true, workProviderSelectionIsValid("codex", "gpt-5.6-sol", "ultra"))
        assertEquals(false, workProviderSelectionIsValid("codex", "gpt-5.6-luna", "ultra"))
        assertEquals(false, workProviderSelectionIsValid("codex", "gpt-5.5-pro", "xhigh"))
    }

    @Test fun dispatchDefaultsPreserveProviderDefaultAndRepairOnlyIllegalExplicitEffort() {
        assertEquals("", normalizedDispatchDefaultEffort("codex", "gpt-5.6-sol", null))
        assertEquals("", normalizedDispatchDefaultEffort("codex", "gpt-5.6-sol", ""))
        assertEquals("ultra", normalizedDispatchDefaultEffort("codex", "gpt-5.6-sol", "ultra"))
        assertEquals("medium", normalizedDispatchDefaultEffort("codex", "gpt-5.6-luna", "ultra"))
    }

    @Test fun sameProviderAllowsOneOmittedSentinelButCrossProviderRequiresConcretePair() {
        assertEquals(true, workProviderSelectionIsValid("codex", "", "ultra", allowOmitted = true))
        assertEquals(true, workProviderSelectionIsValid("codex", "gpt-5.6-luna", "", allowOmitted = true))
        assertEquals(false, workProviderSelectionIsValid("codex", "", "ultra"))
        assertEquals(false, workProviderSelectionIsValid("codex", "gpt-5.6-luna", ""))
        assertEquals(false, workProviderSelectionIsValid("codex", "", "unsupported", allowOmitted = true))
    }

    @Test fun sameProviderNoopIsBlockedButModelOrEffortChangeIsNot() {
        assertEquals(true, sessionConfigIsNoop("codex", "gpt-5.6-sol", "medium", "codex", "gpt-5.6-sol", "medium"))
        assertEquals(false, sessionConfigIsNoop("codex", "gpt-5.6-sol", "medium", "codex", "gpt-5.6-sol", "high"))
        assertEquals(false, sessionConfigIsNoop("codex", "gpt-5.6-sol", "medium", "claude", "sonnet", "medium"))
    }

    @Test fun agentStateDecodesProviderModelAndEffortWithLegacyFallback() {
        val state = AppJson.decodeFromString<AgentState>(
            """{"backend":"claude","providerId":"codex","model":"gpt-5.6-sol","effort":"xhigh"}""",
        )
        assertEquals("codex", agentProvider(state))
        assertEquals("gpt-5.6-sol", state.model)
        assertEquals("xhigh", state.effort)
        assertEquals("claude", agentProvider(AgentState(backend = "claude")))
    }
}
