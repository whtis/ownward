import Foundation
import Testing
@testable import Ownward

struct ProtocolTests {
    @Test func ndjsonFrames() throws {
        #expect(OwnwardClient.parseChatEvent(#"{"type":"delta","text":"你好"}"#) == .delta("你好"))
        #expect(OwnwardClient.parseChatEvent(#"{"type":"tool","text":"联网搜索：x"}"#) == .tool("联网搜索：x"))
        #expect(OwnwardClient.parseChatEvent(#"{"type":"error","msg":"限流"}"#) == .error("限流"))
        let done = OwnwardClient.parseChatEvent(#"{"type":"done","chat":{"id":"c1","title":"T","provider":"codex","model":"m","messages":[{"role":"user","text":"hi"}]}}"#)
        guard case .done(let chat)? = done else { Issue.record("expected done"); return }
        #expect(chat.id == "c1")
        #expect(chat.messages.first?.text == "hi")
        #expect(chat.messages.first?.images.isEmpty == true)   // 缺字段落默认
        #expect(OwnwardClient.parseChatEvent("") == nil)
        #expect(OwnwardClient.parseChatEvent("not json") == nil)
        #expect(OwnwardClient.parseChatEvent(#"{"type":"unknown"}"#) == nil)
    }

    @Test func defaultsTolerateMissingAndNull() throws {
        let json = #"{"messages":[{"role":"assistant","text":null}],"turn":"running","pending":[{"requestId":"r1","toolName":"Bash","input":{"command":"ls"},"brief":"跑 ls"}]}"#
        let s = try JSONDecoder().decode(AgentState.self, from: Data(json.utf8))
        #expect(s.isRunning)
        #expect(s.messages.first?.text == "")
        #expect(s.pending.first?.input?["command"]?.stringValue == "ls")
        #expect(s.control == "")
        #expect(s.canInput == false)   // control 缺失 ≠ ownward，不许输入
    }

    @Test func askQuestionParsing() throws {
        let json = #"{"requestId":"q1","toolName":"AskUserQuestion","input":{"questions":[{"question":"选哪个？","multiSelect":true,"options":[{"label":"A","description":"甲"},{"label":"B"}]}]}}"#
        let perm = try JSONDecoder().decode(PendingPerm.self, from: Data(json.utf8))
        let ask = try #require(AskQuestion.parse(perm))
        #expect(ask.question == "选哪个？")
        #expect(ask.multiSelect)
        #expect(ask.options == [AskOption(label: "A", description: "甲"), AskOption(label: "B", description: "")])
        #expect(AskQuestion.parse(PendingPerm(requestId: "x", toolName: "Bash", input: nil, at: 0, brief: "")) == nil)
    }

    @Test func imageSniff() {
        #expect(ImageEncoder.sniff(Data([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0, 0, 0])) == "image/png")
        #expect(ImageEncoder.sniff(Data([0xFF, 0xD8, 0xFF, 0xE0])) == "image/jpeg")
        #expect(ImageEncoder.sniff(Data("GIF89a....".utf8)) == "image/gif")
        #expect(ImageEncoder.sniff(Data("RIFF....WEBPVP8 ".utf8)) == "image/webp")
        #expect(ImageEncoder.sniff(Data("hello".utf8)) == nil)
    }

    @Test func timeFormatting() {
        #expect(TimeFormat.clock("2026-08-14T09:30:00+08:00") == "09:30")
        #expect(TimeFormat.clock("bad") == "bad")
        let now = Date()
        #expect(TimeFormat.ago(now.addingTimeInterval(-30), now: now) == "刚刚")
        #expect(TimeFormat.ago(now.addingTimeInterval(-600), now: now) == "10 分钟前")
        #expect(TimeFormat.ago(now.addingTimeInterval(-7200), now: now) == "2 小时前")
        #expect(TimeFormat.ago(now.addingTimeInterval(-3 * 86400), now: now) == "3 天前")
        #expect(TimeFormat.parse("2026-08-20T09:20:49.925Z") != nil)
        #expect(TimeFormat.parse("2026-08-14T09:30:00+08:00") != nil)
    }
}
