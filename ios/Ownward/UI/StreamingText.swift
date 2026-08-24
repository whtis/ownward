// ChatGPT 式连续吐字：服务端/轮询给的是一坨一坨的文本（codex 甚至一次给整段），
// 这里用自适应打字机把 displayed 平滑追到 target——落后越多走得越快，永远不会卡成整段跳变。
import SwiftUI
import Observation

@MainActor @Observable
final class TypewriterBuffer {
    private(set) var displayed: String = ""
    private var target: String = ""
    private var pump: Task<Void, Never>?

    var isCatchingUp: Bool { displayed.count < target.count }

    /// 更新目标文本。新文本不是旧显示的延续（服务端重置/替换）时回退到公共前缀再继续。
    func set(_ text: String) {
        guard text != target else { return }
        target = text
        if !text.hasPrefix(displayed) {
            let common = zip(displayed, text).prefix(while: { $0 == $1 }).count
            displayed = String(text.prefix(common))
        }
        start()
    }

    /// 立刻吐完（一轮结束/离开页面）
    func flush() {
        pump?.cancel(); pump = nil
        displayed = target
    }

    func reset() {
        pump?.cancel(); pump = nil
        displayed = ""; target = ""
    }

    private func start() {
        guard pump == nil else { return }
        pump = Task { [weak self] in
            while let self, !Task.isCancelled {
                let shown = displayed.count
                let backlog = target.count - shown
                if backlog <= 0 { break }
                // 60fps：落后 <12 字时逐字；落后越多每帧吃得越多（指数追赶），视觉上仍是连续流
                let step = min(backlog, backlog / 12 + 1)
                // 只用 target 自己的索引（String.Index 不能跨串用），按 Character 偏移不会切开 emoji
                let end = target.index(target.startIndex, offsetBy: shown + step)
                displayed = String(target[..<end])
                try? await Task.sleep(for: .milliseconds(16))
            }
            self?.pump = nil
        }
    }
}

/// 流式 Markdown：复用块渲染，最后一块带圆点光标；文本为空时三点呼吸
struct StreamingMarkdown: View {
    let text: String
    var toolLine: String = ""
    var showCursor = true

    var body: some View {
        if text.isEmpty {
            HStack(spacing: 10) {
                ThinkingDots()
                if !toolLine.isEmpty {
                    Text(toolLine).caption().lineLimit(1)
                        .transition(.opacity)
                }
            }
            .padding(.vertical, 6)
        } else {
            MarkdownBlocks(blocks: MarkdownParser.blocks(text), trailingCursor: showCursor)
        }
    }
}

/// 三点轮流点亮（对齐 android ThinkingDots 的错峰呼吸）。
/// 用 PhaseAnimator 而不是 repeatForever：forever 动画会把同一事务里的布局位移也一起循环，三个点会在屏上乱飘。
struct ThinkingDots: View {
    var body: some View {
        PhaseAnimator([0, 1, 2]) { phase in
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .fill(OW.textDim)
                        .frame(width: 6, height: 6)
                        .opacity(phase == i ? 1 : 0.3)
                }
            }
        } animation: { _ in
            .easeInOut(duration: 0.35)
        }
        .accessibilityLabel("正在思考")
    }
}
