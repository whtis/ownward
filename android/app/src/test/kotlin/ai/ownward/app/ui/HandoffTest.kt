package ai.ownward.app.ui

import ai.ownward.app.data.AgentState
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
}
