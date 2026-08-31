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

    @Test func 会话能力精确匹配模型矩阵() {
        #expect(workCodexModelEfforts == [
            "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
            "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
            "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
            "gpt-5.5": ["low", "medium", "high", "xhigh"],
            "gpt-5.4": ["low", "medium", "high", "xhigh"],
        ])
        #expect(workProviderEfforts("claude", model: "sonnet") == ["low", "medium", "high", "xhigh", "max"])
        #expect(workProviderEfforts("codebuddy", model: "hy3") == workProviderEfforts("claude", model: "sonnet"))
        #expect(workProviderEfforts("codex", model: "gpt-5.5-pro").isEmpty)
        #expect(workProviderDefaultModel("codex") == "gpt-5.6-sol")
        #expect(workProviderHandoffModel("codex") == "gpt-5.6-sol")
    }

    @Test func 服务端默认模型表只有sol时_仍补齐所有任务模型() {
        #expect(workProviderModels("codex", providers: ["codex": ["gpt-5.6-sol"]]) == [
            "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4",
        ])
    }

    @Test func 模型变化选择受支持默认值_旧非法组合不能提交() {
        #expect(workProviderDefaultEffort("codex", model: "gpt-5.4") == "medium")
        #expect(workProviderSelectionIsValid("codex", model: "gpt-5.6-sol", effort: "ultra"))
        #expect(!workProviderSelectionIsValid("codex", model: "gpt-5.6-luna", effort: "ultra"))
        #expect(!workProviderSelectionIsValid("codex", model: "gpt-5.5-pro", effort: "xhigh"))
    }

    @Test func 派发默认值保留Provider默认_只修复非法显式深度() {
        #expect(normalizedDispatchDefaultEffort("codex", model: "gpt-5.6-sol", configured: nil) == "")
        #expect(normalizedDispatchDefaultEffort("codex", model: "gpt-5.6-sol", configured: "") == "")
        #expect(normalizedDispatchDefaultEffort("codex", model: "gpt-5.6-sol", configured: "ultra") == "ultra")
        #expect(normalizedDispatchDefaultEffort("codex", model: "gpt-5.6-luna", configured: "ultra") == "medium")
    }

    @Test func 同Provider允许单个省略哨兵_跨Provider仍要求具体组合() {
        #expect(workProviderSelectionIsValid("codex", model: "", effort: "ultra", allowOmitted: true))
        #expect(workProviderSelectionIsValid("codex", model: "gpt-5.6-luna", effort: "", allowOmitted: true))
        #expect(!workProviderSelectionIsValid("codex", model: "", effort: "ultra"))
        #expect(!workProviderSelectionIsValid("codex", model: "gpt-5.6-luna", effort: ""))
        #expect(!workProviderSelectionIsValid("codex", model: "", effort: "unsupported", allowOmitted: true))
    }

    @Test func 接力请求省略空哨兵字段() {
        let body = devHandoffBody(
            id: "task 1", providerId: "codex", confirmUnknownOutcome: false,
            model: "", effort: "high", reason: "manual-reconfigure")
        #expect(body["model"] == nil)
        #expect(body["effort"] == .string("high"))
    }

    @Test func 同Provider无变化会被拦截_修改模型或深度则允许() {
        #expect(sessionConfigIsNoop(
            currentProvider: "codex", currentModel: "gpt-5.6-sol", currentEffort: "medium",
            provider: "codex", model: "gpt-5.6-sol", effort: "medium"))
        #expect(!sessionConfigIsNoop(
            currentProvider: "codex", currentModel: "gpt-5.6-sol", currentEffort: "medium",
            provider: "codex", model: "gpt-5.6-sol", effort: "high"))
        #expect(!sessionConfigIsNoop(
            currentProvider: "codex", currentModel: "gpt-5.6-sol", currentEffort: "medium",
            provider: "claude", model: "sonnet", effort: "medium"))
    }

    @Test func 状态可解码Provider模型和思考深度_老daemon回退backend() throws {
        let decoded = try state(#"{"backend":"claude","providerId":"codex","model":"gpt-5.6-sol","effort":"xhigh"}"#)
        #expect(agentProvider(decoded) == "codex")
        #expect(decoded.model == "gpt-5.6-sol")
        #expect(decoded.effort == "xhigh")
        #expect(agentProvider(try state(#"{"backend":"claude"}"#)) == "claude")
    }
}
