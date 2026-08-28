// 对话供应商·模型选定（对齐 android ui/ChatProviderSelectionTest.kt）：
// 空表报错、新对话落到可用表、既有对话的组合不可用要报错而不是悄悄换。
import Foundation
import Testing
@testable import Ownward

struct ChatProviderSelectionTests {
    @Test func 服务端一个可用模型都没有时报错() {
        #expect { try selectChatProvider(raw: [:], requestedProvider: "codex", requestedModel: "default", existingChat: false) }
            throws: { ($0 as? ChatProviderError)?.message.contains("没有可用") == true }
        // 供应商有键但型号表全空，同样算没有可用
        #expect { try selectChatProvider(raw: ["codex": []], requestedProvider: "codex", requestedModel: "default", existingChat: false) }
            throws: { ($0 as? ChatProviderError)?.message.contains("没有可用") == true }
    }

    @Test func 新对话请求的供应商没货就落到可用表第一个() throws {
        let sel = try selectChatProvider(raw: ["codex": [], "claude": ["sonnet"]],
                                         requestedProvider: "codex", requestedModel: "default", existingChat: false)
        #expect(sel.providers == ["claude": ["sonnet"]])   // 空型号表的供应商被过滤掉
        #expect(sel.provider == "claude")
        #expect(sel.model == "sonnet")
    }

    @Test func 既有对话的组合当前不可用要报错_不许悄悄换() {
        #expect { try selectChatProvider(raw: ["codex": ["new"]], requestedProvider: "codex", requestedModel: "old", existingChat: true) }
            throws: { ($0 as? ChatProviderError)?.message.contains("当前不可用") == true }
    }

    @Test func 既有对话组合可用就原样跟随() throws {
        let sel = try selectChatProvider(raw: ["codex": ["gpt", "mini"]],
                                         requestedProvider: "codex", requestedModel: "mini", existingChat: true)
        #expect(sel.provider == "codex")
        #expect(sel.model == "mini")
    }
}
