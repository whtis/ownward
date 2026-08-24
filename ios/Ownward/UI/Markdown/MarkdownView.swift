// Markdown 渲染（块级 VStack + 行内 AttributedString）。流式场景每帧重渲，所以行内
// AttributedString 按原文缓存——只有最后一个块在变，其它块零成本命中。
import SwiftUI
import UIKit

@MainActor
enum InlineCache {
    private static var cache: [String: AttributedString] = [:]

    static func attributed(_ text: String) -> AttributedString {
        if let hit = cache[text] { return hit }
        let built = build(text)
        if cache.count > 600 { cache.removeAll(keepingCapacity: true) }
        cache[text] = built
        return built
    }

    private static func build(_ text: String) -> AttributedString {
        var out = AttributedString()
        for run in MarkdownParser.inlineRuns(text) {
            switch run {
            case .text(let s):
                out += AttributedString(s)
            case .bold(let s):
                var a = AttributedString(s); a.inlinePresentationIntent = .stronglyEmphasized; out += a
            case .italic(let s):
                var a = AttributedString(s); a.inlinePresentationIntent = .emphasized; out += a
            case .code(let s):
                var a = AttributedString(s)
                a.font = .system(size: 13, design: .monospaced)
                a.backgroundColor = OW.surface3
                out += a
            case .link(let t, let u):
                var a = AttributedString(t)
                a.link = URL(string: u)
                a.foregroundColor = OW.accent
                a.underlineStyle = .single
                out += a
            }
        }
        return out
    }
}

struct MarkdownText: View {
    let text: String
    var body: some View {
        MarkdownBlocks(blocks: MarkdownParser.blocks(text))
    }
}

/// 块列表；trailingCursor=true 时在最后一个文本块末尾追加 ChatGPT 式圆点光标
struct MarkdownBlocks: View {
    let blocks: [MdBlock]
    var trailingCursor = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { idx, block in
                if idx > 0 {
                    // 间距分级：标题前 16 拉开小节，标题后 6 贴住正文，其余 10
                    let prev = blocks[idx - 1]
                    Spacer(minLength: 0).frame(height: block.isHeading ? 16 : (prev.isHeading ? 6 : 10))
                }
                blockView(block, cursor: trailingCursor && idx == blocks.count - 1)
            }
            if trailingCursor && (blocks.isEmpty || !blocks[blocks.count - 1].takesCursor) {
                Cursor()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: MdBlock, cursor: Bool) -> some View {
        switch block {
        case .heading(let level, let text):
            inlineText(text, cursor: cursor)
                .font(level == 1 ? .owTitle : (level == 2 ? .owTitleM : .owTitleS))
                .lineSpacing(4)
        case .paragraph(let text):
            inlineText(text, cursor: cursor).messageBody()
        case .code(let lang, let code):
            CodeBlock(lang: lang, code: code)
        case .quote(let lines):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5).fill(OW.outline).frame(width: 3)
                inlineText(lines.joined(separator: "\n"), cursor: cursor).messageBody().foregroundStyle(OW.textDim)
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 2)
        case .list(let items, let ordered):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { n, item in
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        Text(ordered ? "\(n + 1). " : "•  ").messageBody().foregroundStyle(OW.textDim)
                        inlineText(item, cursor: cursor && n == items.count - 1).messageBody()
                    }
                }
            }
        case .table(let header, let rows):
            MdTable(header: header, rows: rows)
        case .rule:
            Rectangle().fill(OW.outlineFaint).frame(height: 1).padding(.vertical, 4)
        }
    }

    private func inlineText(_ text: String, cursor: Bool) -> Text {
        let t = Text(InlineCache.attributed(text))
        return cursor ? Text("\(t)\(Text(" ●").foregroundStyle(OW.textDim))") : t
    }
}

private extension MdBlock {
    var isHeading: Bool { if case .heading = self { return true } else { return false } }
    var takesCursor: Bool {
        switch self { case .heading, .paragraph, .quote, .list: return true; default: return false }
    }
}

/// 独立光标（内容为空或最后一块是代码/表格时）
struct Cursor: View {
    var body: some View {
        Circle().fill(OW.textDim).frame(width: 9, height: 9).padding(.top, 8)
    }
}

/// 代码块：语言 header + 一键复制，等宽 13/19，横向滚动
struct CodeBlock: View {
    let lang: String
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(lang.isEmpty ? "code" : lang).font(.system(size: 12, design: .monospaced)).foregroundStyle(OW.textDim)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    Haptics.selection()
                    withAnimation(.snappy) { copied = true }
                    Task { try? await Task.sleep(for: .seconds(1.5)); withAnimation { copied = false } }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(copied ? OW.success : OW.textDim)
                        .contentTransition(.symbolEffect(.replace))
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("复制代码")
            }
            .padding(.leading, 12)
            .frame(height: 32)
            .background(OW.surface3)
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.owMono)
                    .lineSpacing(6)
                    .padding(12)
                    .textSelection(.enabled)
            }
        }
        .background(OW.surface1)
        .clipShape(RoundedRectangle(cornerRadius: OWRadius.m))
    }
}

/// 表格：等分列宽 + hairline 分隔；agent 输出里表格是高频内容
struct MdTable: View {
    let header: [String]
    let rows: [[String]]

    var body: some View {
        let cols = max(header.count, 1)
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 6) {
                ForEach(0..<cols, id: \.self) { c in
                    Text(InlineCache.attributed(c < header.count ? header[c] : ""))
                        .font(.system(size: 13, weight: .medium)).lineSpacing(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(OW.surface2)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                Rectangle().fill(OW.outlineFaint).frame(height: 1)
                HStack(alignment: .top, spacing: 6) {
                    ForEach(0..<cols, id: \.self) { c in
                        Text(InlineCache.attributed(c < row.count ? row[c] : ""))
                            .font(.owBodyS).lineSpacing(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(OW.outlineFaint, lineWidth: 1))
    }
}
