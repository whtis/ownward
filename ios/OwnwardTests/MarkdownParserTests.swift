import Testing
@testable import Ownward

struct MarkdownParserTests {
    @Test func headingsParagraphsAndRules() {
        let blocks = MarkdownParser.blocks("# 标题\n\n正文一\n正文二\n\n---\n## 二级")
        #expect(blocks == [
            .heading(level: 1, text: "标题"),
            .paragraph("正文一\n正文二"),
            .rule,
            .heading(level: 2, text: "二级"),
        ])
    }

    @Test func unclosedCodeFenceEatsToEnd() {
        let blocks = MarkdownParser.blocks("```swift\nlet a = 1\nprint(a)")
        #expect(blocks == [.code(lang: "swift", text: "let a = 1\nprint(a)")])
    }

    @Test func listsQuotesTables() {
        let src = "- 一\n- 二\n1. 甲\n2) 乙\n> 引\n> 用\n| a | b |\n|---|---|\n| 1 | 2 |"
        let blocks = MarkdownParser.blocks(src)
        #expect(blocks == [
            .list(items: ["一", "二"], ordered: false),
            .list(items: ["甲", "乙"], ordered: true),
            .quote(["引", "用"]),
            .table(header: ["a", "b"], rows: [["1", "2"]]),
        ])
    }

    @Test func inlineRuns() {
        let runs = MarkdownParser.inlineRuns("看 **粗** 和 *斜* 以及 `code` 和 [链接](https://x.y/z)。")
        #expect(runs == [
            .text("看 "), .bold("粗"), .text(" 和 "), .italic("斜"), .text(" 以及 "), .code("code"),
            .text(" 和 "), .link(text: "链接", url: "https://x.y/z"), .text("。"),
        ])
    }

    @Test func tableCellsTrimOuterPipes() {
        #expect(MarkdownParser.tableCells("| a | b c |") == ["a", "b c"])
        #expect(MarkdownParser.isTableRule("|:---|---:|"))
        #expect(!MarkdownParser.isTableRule("| a | b |"))
    }
}
