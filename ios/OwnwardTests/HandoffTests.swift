// 跨引擎接力（对齐 android ui/HandoffTest.kt）：不能切的原因、引擎标签回退链、二次确认的判定。
import Foundation
import Testing
@testable import Ownward

private func state(_ json: String) throws -> AgentState {
    try JSONDecoder().decode(AgentState.self, from: Data(json.utf8))
}

struct HandoffTests {
    @Test func 空闲且ownward持有输入权的会话可以切() throws {
        #expect(handoffBlockReason(try state(#"{"control":"ownward","backend":"claude"}"#)) == nil)
    }

    @Test func 忙碌状态逐条说清为什么不能切() throws {
        #expect(handoffBlockReason(try state(#"{"control":"ownward","turn":"running"}"#))
            == "当前轮次运行中，请等待结束或先中断")
        #expect(handoffBlockReason(try state(#"{"control":"ownward","pending":[{"requestId":"p"}]}"#))
            == "有待处理的审批，请先确认")
        #expect(handoffBlockReason(try state(#"{"control":"ownward","queued":[{"id":"q"}]}"#))
            == "有排队消息，请先等待发送或撤回")
        #expect(handoffBlockReason(try state(#"{"control":"external"}"#))
            == "仅 ownward 持有输入权时可切换")
        #expect(handoffBlockReason(try state(#"{"control":"ownward","operability":"read-only"}"#))
            == "会话已归档，不能切换")
    }

    @Test func 引擎标签优先provider其次backend_老daemon回退mode() {
        #expect(engineLabel("claude-bg", backend: "claude", providerId: "codebuddy") == "codebuddy")
        #expect(engineLabel("claude-bg", backend: "codebuddy") == "codebuddy")
        #expect(engineLabel("codebuddy-bg") == "codebuddy")
        #expect(engineLabel("claude-bg") == "claude")
        #expect(engineLabel("codex-bg") == "codex")
    }

    @Test func 只有结果未知这一个策略错误才要求强确认() {
        #expect(needsUnknownHandoffConfirmation(
            ApiError(code: 400, message: "confirm", errorCode: "SESSION_HANDOFF_UNKNOWN_CONFIRM_REQUIRED")))
        #expect(!needsUnknownHandoffConfirmation(
            ApiError(code: 400, message: "other", errorCode: "SESSION_BUSY")))
        #expect(!needsUnknownHandoffConfirmation(URLError(.timedOut)))
    }
}
