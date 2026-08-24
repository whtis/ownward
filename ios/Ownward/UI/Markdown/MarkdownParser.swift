// 对齐 web/app.js mdHtml() 与 android ui/Markdown.kt 的语法子集 + 表格。
// 流式渲染时未闭合的代码围栏一路吃到结尾（有意为之）。纯函数，可单测。
import Foundation

enum MdBlock: Equatable, Sendable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case code(lang: String, text: String)
    case quote([String])
    case list(items: [String], ordered: Bool)
    case table(header: [String], rows: [[String]])
    case rule
}

enum InlineRun: Equatable, Sendable {
    case text(String)
    case bold(String)
    case italic(String)
    case code(String)
    case link(text: String, url: String)
}

enum MarkdownParser {
    private static let headingRe = try! NSRegularExpression(pattern: "^#{1,4}\\s+.*$")
    private static let ruleRe = try! NSRegularExpression(pattern: "^(---+|\\*\\*\\*+)\\s*$")
    private static let bulletRe = try! NSRegularExpression(pattern: "^\\s*[-*]\\s+")
    private static let orderedRe = try! NSRegularExpression(pattern: "^\\s*\\d+[.)]\\s+")
    private static let inlineRe = try! NSRegularExpression(
        pattern: "(\\*\\*(.+?)\\*\\*)|(\\*(.+?)\\*)|(`([^`]+)`)|(\\[([^\\]]+)\\]\\((https?://[^)\\s]+)\\))")

    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    /// 去掉列表前缀（`- `、`1. `），没匹配到就原样返回
    private static func stripPrefix(_ re: NSRegularExpression, _ s: String) -> String {
        guard let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
              let r = Range(m.range, in: s) else { return s }
        return String(s[r.upperBound...])
    }

    /// `| a | b |` → ["a","b"]
    static func tableCells(_ line: String) -> [String] {
        var t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") { t.removeLast() }
        return t.split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// 表格分隔行：`|---|:--:|` 之类
    static func isTableRule(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        return t.hasPrefix("|") && t.contains("---") && t.allSatisfy { "|-: \t".contains($0) }
    }

    static func blocks(_ src: String) -> [MdBlock] {
        var blocks: [MdBlock] = []
        let lines = src.components(separatedBy: "\n")
        var i = 0
        var para: [String] = []
        func flushPara() {
            let joined = para.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty { blocks.append(.paragraph(joined)) }
            para.removeAll()
        }
        while i < lines.count {
            let line = lines[i]
            let ltrim = line.drop(while: { $0 == " " || $0 == "\t" })
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if ltrim.hasPrefix("```") {
                flushPara()
                let lang = String(ltrim.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var code: [String] = []
                i += 1
                while i < lines.count, !lines[i].drop(while: { $0 == " " || $0 == "\t" }).hasPrefix("```") {
                    code.append(lines[i]); i += 1
                }
                blocks.append(.code(lang: lang, text: code.joined(separator: "\n")))
            } else if trimmed.hasPrefix("|"), i + 1 < lines.count, isTableRule(lines[i + 1]) {
                flushPara()
                let header = tableCells(line)
                i += 2
                var rows: [[String]] = []
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    rows.append(tableCells(lines[i])); i += 1
                }
                blocks.append(.table(header: header, rows: rows))
                continue
            } else if matches(headingRe, line) {
                flushPara()
                let level = line.prefix(while: { $0 == "#" }).count
                blocks.append(.heading(level: level, text: String(line.drop(while: { $0 == "#" })).trimmingCharacters(in: .whitespaces)))
            } else if matches(ruleRe, line) {
                flushPara(); blocks.append(.rule)
            } else if line.hasPrefix("> ") || line == ">" {
                flushPara()
                var quote: [String] = []
                while i < lines.count, lines[i].hasPrefix("> ") || lines[i] == ">" {
                    var q = String(lines[i].dropFirst())
                    if q.hasPrefix(" ") { q.removeFirst() }
                    quote.append(q); i += 1
                }
                blocks.append(.quote(quote))
                continue
            } else if matches(bulletRe, line) {
                flushPara()
                var items: [String] = []
                while i < lines.count, matches(bulletRe, lines[i]) {
                    items.append(stripPrefix(bulletRe, lines[i])); i += 1
                }
                blocks.append(.list(items: items, ordered: false))
                continue
            } else if matches(orderedRe, line) {
                flushPara()
                var items: [String] = []
                while i < lines.count, matches(orderedRe, lines[i]) {
                    items.append(stripPrefix(orderedRe, lines[i])); i += 1
                }
                blocks.append(.list(items: items, ordered: true))
                continue
            } else if trimmed.isEmpty {
                flushPara()
            } else {
                para.append(line)
            }
            i += 1
        }
        flushPara()
        return blocks
    }

    /// 行内语法：**粗** *斜* `代码` [文字](https://链接)
    static func inlineRuns(_ text: String) -> [InlineRun] {
        var runs: [InlineRun] = []
        let ns = text as NSString
        var cursor = 0
        for m in inlineRe.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if m.range.location > cursor {
                runs.append(.text(ns.substring(with: NSRange(location: cursor, length: m.range.location - cursor))))
            }
            func group(_ i: Int) -> String? {
                let r = m.range(at: i)
                return r.location == NSNotFound || r.length == 0 ? nil : ns.substring(with: r)
            }
            if let b = group(2) { runs.append(.bold(b)) }
            else if let it = group(4) { runs.append(.italic(it)) }
            else if let c = group(6) { runs.append(.code(c)) }
            else if let t = group(8), let u = group(9) { runs.append(.link(text: t, url: u)) }
            cursor = m.range.location + m.range.length
        }
        if cursor < ns.length { runs.append(.text(ns.substring(from: cursor))) }
        return runs
    }
}
