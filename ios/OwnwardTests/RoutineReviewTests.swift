// 例行草稿审阅规则（对齐 android ui/RoutineReviewTest.kt）：可编辑/可提交判定、按状态给动作、
// 保存失败绝不触发写入；外加草稿接口的 query 拼接与解码。
import Foundation
import Testing
@testable import Ownward

struct RoutineReviewTests {
    @Test func 只有draft状态可编辑() {
        #expect(routineCanEdit("draft"))
        for s in ["writing", "written", "skipped", "pending", "upcoming"] { #expect(!routineCanEdit(s), "\(s)") }
    }

    @Test func 提交要求载入成功且处于草稿状态() {
        #expect(!routineCanSubmit("draft", loadedSuccessfully: false))
        #expect(!routineCanSubmit("written", loadedSuccessfully: true))
        #expect(!routineCanSubmit("skipped", loadedSuccessfully: true))
        #expect(routineCanSubmit("draft", loadedSuccessfully: true))
    }

    @Test func 动作按例行状态给() {
        #expect(routineActions(card("pending")) == ["generate"])
        #expect(routineActions(card("draft", hasDraft: true)) == ["view", "skip"])
        #expect(routineActions(card("writing", hasDraft: true, taskId: "t")) == ["view", "task"])
        #expect(routineActions(card("written", hasDraft: true)) == ["view"])
        #expect(routineActions(card("skipped", hasDraft: true)) == ["view"])
        #expect(routineActions(card("upcoming", docUrl: "https://example.com")) == ["document"])
    }

    @Test func 保存失败绝不触发写入() async {
        var writes = 0
        do {
            try await saveThenWrite(save: { throw ApiError(code: 500, message: "保存失败") }, write: { writes += 1 })
            Issue.record("保存失败应当抛错")
        } catch {
            #expect(error.userMessage == "保存失败")
        }
        #expect(writes == 0)
    }

    @Test func 草稿接口query转义与解码() throws {
        #expect(OwnwardClient.routineDraftPath(id: "weekly report", date: "2026-09-02")
            == "/api/routines/draft?id=weekly%20report&date=2026-09-02")
        #expect(OwnwardClient.routineDraftPath(id: "a&b=c", date: "d") == "/api/routines/draft?id=a%26b%3Dc&date=d")
        let d = try JSONDecoder().decode(RoutineDraft.self, from: Data(
            #"{"ok":true,"draft":"周报正文","status":"draft","stale":true}"#.utf8))
        #expect(d.ok && d.draft == "周报正文" && d.status == "draft" && d.stale && d.msg.isEmpty)
        let missing = try JSONDecoder().decode(RoutineDraft.self, from: Data(#"{"ok":false,"msg":"没有草稿"}"#.utf8))
        #expect(!missing.ok && missing.msg == "没有草稿")
    }

    @Test func okMsg的ok为false也算失败() throws {
        let bad = try JSONDecoder().decode(OkMsg.self, from: Data(#"{"ok":false,"msg":"草稿已过期"}"#.utf8))
        #expect(throws: ApiError(code: 200, message: "草稿已过期")) { try bad.requireOk() }
        let silent = try JSONDecoder().decode(OkMsg.self, from: Data(#"{"ok":false}"#.utf8))
        #expect(throws: ApiError(code: 200, message: "保存失败")) { try silent.requireOk("保存失败") }
        #expect(try JSONDecoder().decode(OkMsg.self, from: Data(#"{"ok":true}"#.utf8)).requireOk().ok)
    }

    private func card(_ status: String, hasDraft: Bool = false, taskId: String? = nil, docUrl: String? = nil) -> RoutineCard {
        var json = #"{"id":"r","status":"\#(status)","hasDraft":\#(hasDraft)"#
        if let taskId { json += #","taskId":"\#(taskId)""# }
        if let docUrl { json += #","docUrl":"\#(docUrl)""# }
        json += "}"
        return try! JSONDecoder().decode(RoutineCard.self, from: Data(json.utf8))
    }
}
