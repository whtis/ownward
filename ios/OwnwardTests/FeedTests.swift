// 与 android FeedTest.kt 逐条配对：折叠规则是三端（web/android/ios）共享的口径，
// 分组错了会让 ForEach 的 id 撞车——肉眼看不出来，只能靠测试钉住。
import Foundation
import Testing
@testable import Ownward

private func tool(_ name: String, _ text: String = "") -> DevMsg {
    DevMsg(role: "tool", text: text, name: name, ts: "", images: nil)
}
private func user(_ text: String) -> DevMsg { DevMsg(role: "user", text: text, name: nil, ts: "", images: nil) }
private func assistant(_ text: String) -> DevMsg { DevMsg(role: "assistant", text: text, name: nil, ts: "", images: nil) }
private func image() -> DevMsg { DevMsg(role: "tool", text: "🖼 图片 ×1", name: "image", ts: "", images: nil) }

/// 展开每一项，还原成原来的消息序列——折叠不能丢消息也不能改顺序
private func flatten(_ feed: [FeedItem]) -> [DevMsg] {
    feed.flatMap { item -> [DevMsg] in
        switch item {
        case .one(_, let m): [m]
        case .tools(_, let ms): ms
        }
    }
}

private func toolsCount(_ item: FeedItem) -> Int {
    if case .tools(_, let ms) = item { return ms.count }
    return -1
}

struct FeedTests {
    @Test func 连续工具调用折成一组_非工具消息原样保留() {
        let msgs = [
            user("开工"),
            tool("Edit", "src/a.ts"), tool("Bash", "bun test"), tool("Read", "src/b.ts"), tool("Edit", "src/c.ts"),
            assistant("做完了"),
        ]
        let feed = foldToolRuns(msgs)
        #expect(feed.count == 3)
        if case .one = feed[0] {} else { Issue.record("第一项该是普通消息") }
        #expect(toolsCount(feed[1]) == 4)
        if case .one = feed[2] {} else { Issue.record("第三项该是普通消息") }
        #expect(flatten(feed) == msgs)
    }

    @Test func 不到minRun条不折_两行本来就不碍事() {
        let msgs = [user("嗨"), tool("Bash", "git status"), tool("Read", "a.ts"), assistant("好")]
        let feed = foldToolRuns(msgs)
        #expect(feed.allSatisfy { if case .tools = $0 { return false } else { return true } })
        #expect(feed.count == 4)
        #expect(flatten(feed) == msgs)
    }

    @Test func 图片行断开一段执行_且顺序原样不动() {
        let msgs = [
            tool("Read", "1"), tool("Read", "2"), tool("Read", "3"),
            image(),
            tool("Edit", "4"), tool("Edit", "5"), tool("Edit", "6"),
        ]
        let feed = foldToolRuns(msgs)
        #expect(feed.count == 3)
        #expect(toolsCount(feed[0]) == 3)
        if case .one(_, let m) = feed[1] { #expect(m.name == "image") } else { Issue.record("图片该单独成项") }
        #expect(toolsCount(feed[2]) == 3)
        #expect(flatten(feed) == msgs)   // 图片没有被挪到组后面
    }

    @Test func index唯一且递增_重复id会让ForEach错乱() {
        let msgs = [
            user("a"),
            tool("Bash", "1"), tool("Bash", "2"),                  // 短跑：拆成两条 one，index 不能撞
            assistant("b"),
            tool("Edit", "3"), tool("Edit", "4"), tool("Edit", "5"),
            image(),
            tool("Read", "6"),
            user("c"),
        ]
        let keys = foldToolRuns(msgs).map(\.index)
        #expect(keys.count == Set(keys).count)
        #expect(keys == keys.sorted())
        #expect(flatten(foldToolRuns(msgs)) == msgs)
    }

    @Test func 组的index是起点_尾部那组变长时id不变() {
        let head = [user("开工"), tool("Edit", "1"), tool("Edit", "2"), tool("Edit", "3")]
        let grown = head + [tool("Edit", "4"), tool("Bash", "5")]
        #expect(foldToolRuns(head).map(\.index) == foldToolRuns(grown).map(\.index))
    }

    @Test func 收起时的副标题_跑完看类型汇总_还在跑看当前这条() {
        let msgs = [
            tool("Edit", "a"), tool("Edit", "b"), tool("Bash", "bun test"),
            tool("⚠️ 出错", "boom"), tool("Read", "c"),
        ]
        // 汇总按次数降序；出错不混进类型汇总（它单独在标题上标红计数）
        #expect(toolRunSubtitle(msgs, live: false) == "Edit ×2 · Bash · Read")
        // 还在跑：显示最后一条，且只取首行——工具输出可能是多行的
        #expect(toolRunSubtitle([tool("Bash", "bun test\n3 pass")], live: true) == "Bash bun test")
    }

    @Test func 超过3类会带省略号_不把标题撑爆() {
        let msgs = [tool("Edit"), tool("Bash"), tool("Read"), tool("Grep")]
        #expect(toolRunSubtitle(msgs, live: false).hasSuffix(" …"))
    }

    @Test func 出错行认得出来_折叠可以省过程不能把失败一起藏了() {
        #expect(tool("⚠️ 出错", "boom").isToolError)
        #expect(tool("⛔ 已拒绝", "denied").isToolError)
        #expect(!tool("Edit", "a.ts").isToolError)
    }

    // 与 android 的 `空工具名当 tool` / web-feed.test.ts 同名用例配对：
    // Kotlin 的 elvis 只挡 null、JS 的 || 连空串一起挡，Swift 得显式 takeIf——不钉住就会漂
    @Test func 空工具名当tool_三端口径必须一致() {
        #expect(toolRunSubtitle([tool("", "做点什么")], live: true).split(separator: " ").first == "tool")
        #expect(toolRunSubtitle([tool(""), tool("")], live: false) == "tool ×2")
    }

    @Test func 空列表不炸() {
        #expect(foldToolRuns([]).isEmpty)
        #expect(toolRunSubtitle([], live: true) == "")
    }
}
