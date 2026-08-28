// 通用组件（对齐 android ui/Components.kt）：状态点、分节头、错误横幅、权限/提问卡、
// 任务会话消息行、工具行、计划条、队列条、带鉴权的图片。
import SwiftUI
import UIKit

struct StatusDot: View {
    let color: Color
    var size: CGFloat = 8
    var body: some View { Circle().fill(color).frame(width: size, height: size) }
}

struct SectionHeader: View {
    let text: String
    var body: some View {
        Text(text).font(.owLabel).foregroundStyle(OW.textDim)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16).padding(.vertical, 8)
    }
}

struct ErrorBanner: View {
    let message: String?
    var body: some View {
        if let message, !message.isEmpty {
            Text(message)
                .font(.owBodyS).foregroundStyle(OW.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(OW.danger.opacity(0.14), in: RoundedRectangle(cornerRadius: OWRadius.m))
                .padding(.horizontal, 16).padding(.vertical, 4)
                .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }
}

struct EmptyHint: View {
    let text: String
    var body: some View {
        Text(text).listBody().foregroundStyle(OW.textDim)
            .frame(maxWidth: .infinity, alignment: .leading).padding(32)
    }
}

struct InfoRow: View {
    let label: String
    let value: String
    var body: some View {
        HStack(alignment: .top) {
            Text(label).listBody().foregroundStyle(OW.textDim).frame(width: 80, alignment: .leading)
            Text(value).listBody()
        }
        .padding(.vertical, 6)
    }
}

// MARK: - 搜索与列表行（侧边栏、任务页、对话页共用，三处口径/样式不会各走各的）

/// 搜索命中：空查询全放行；任一字段包含即命中（忽略大小写）
func searchHit(_ query: String, _ fields: String?...) -> Bool {
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if q.isEmpty { return true }
    return fields.contains { $0?.localizedCaseInsensitiveContains(q) == true }
}

/// 会话引擎标签：RecentSession.mode 形如 codex-bg / claude-bg
/// 新 daemon 给真实 provider（接力后 mode 不再可信）；老 daemon 回退到 mode（android ui/Components.kt 同款）
func engineLabel(_ mode: String, backend: String? = nil, providerId: String? = nil) -> String {
    if let p = providerId, !p.isEmpty { return p }
    if let b = backend, !b.isEmpty { return b }
    if mode.hasPrefix("codex") { return "codex" }
    if mode.hasPrefix("codebuddy") { return "codebuddy" }
    return "claude"
}

/// 列表行副标题：「项目 · 引擎 · 时间」，空段自动省略
func sessionSub(_ parts: String?...) -> String {
    parts.compactMap { $0 }.filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.joined(separator: " · ")
}

/// 列表行：状态点 + 标题一行 + 「项目 · 引擎 · 时间」一行。
/// 紧凑（两行）是刻意的——任务/会话动辄上百条，卡片式三行的列表滚不到底。
struct EntityRow<Trailing: View>: View {
    let title: String
    let sub: String
    var dot: Color?
    var selected = false
    let action: () -> Void
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 10) {
            Button(action: action) {
                HStack(spacing: 10) {
                    if let dot { StatusDot(color: dot) }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).listBody().foregroundStyle(OW.text).lineLimit(1)
                        if !sub.isEmpty { Text(sub).font(.owLabelS).foregroundStyle(OW.textDim).lineLimit(1) }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            trailing()
        }
        .padding(.leading, 12).padding(.trailing, 8).padding(.vertical, 8)
        .background(selected ? OW.surface2 : Color.clear, in: RoundedRectangle(cornerRadius: OWRadius.m))
        .padding(.horizontal, 8).padding(.vertical, 1)
    }
}

extension EntityRow where Trailing == EmptyView {
    init(title: String, sub: String, dot: Color? = nil, selected: Bool = false, action: @escaping () -> Void) {
        self.init(title: title, sub: sub, dot: dot, selected: selected, action: action, trailing: { EmptyView() })
    }
}

/// 药丸搜索框（侧边栏用；列表页走 iOS 原生 .searchable，过滤口径同为 searchHit）。
/// 展开即抢焦点弹键盘，X 关闭并清空。
struct SearchField: View {
    @Binding var text: String
    var placeholder = "搜索任务、会话、对话"
    let onClose: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 15)).foregroundStyle(OW.textDim)
            TextField(placeholder, text: $text)
                .font(.owBody).tint(OW.accent).focused($focused)
                .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
            Button { Haptics.tap(); onClose() } label: {
                Image(systemName: "xmark.circle.fill").font(.system(size: 16)).foregroundStyle(OW.textDim)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("关闭搜索")
        }
        .padding(.leading, 14).padding(.trailing, 10)
        .frame(height: 44)
        .background(OW.surface2, in: Capsule())
        .onAppear { focused = true }
    }
}

// MARK: - 长按复制

extension View {
    /// 长按复制整条消息。流式输出途中同样可用——复制的是当前已经吐出来的那部分，
    /// 所以传的是 @autoclosure（点菜单时现取），不能在组合时把字符串定死。
    func copyOnLongPress(_ text: @escaping @autoclosure () -> String) -> some View {
        contextMenu {
            Button {
                let t = text().trimmingCharacters(in: .whitespacesAndNewlines)
                guard !t.isEmpty else { return }
                UIPasteboard.general.string = t
                Haptics.selection()
            } label: { Label("复制", systemImage: "doc.on.doc") }
        }
    }
}

/// 滚到底部的玻璃圆钮（ChatGPT 式：离开底部时出现）
struct ScrollToBottomButton: View {
    let action: () -> Void
    var body: some View {
        Button {
            Haptics.tap(); action()
        } label: {
            Image(systemName: "arrow.down").font(.system(size: 15, weight: .semibold)).frame(width: 36, height: 36)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .accessibilityLabel("滚到底部")
    }
}

// MARK: - AskUserQuestion 解析（结构见 web/tasks.js 权限卡分支）

struct AskOption: Equatable, Sendable, Hashable {
    let label: String
    let description: String
}

struct AskQuestion: Equatable, Sendable {
    let question: String
    let options: [AskOption]
    let multiSelect: Bool

    static func parse(_ perm: PendingPerm) -> AskQuestion? {
        guard perm.toolName == "AskUserQuestion",
              let q = perm.input?["questions"]?.arrayValue?.first,
              let opts = q["options"]?.arrayValue else { return nil }
        return AskQuestion(
            question: q["question"]?.stringValue ?? "",
            options: opts.prefix(6).map {
                AskOption(label: $0["label"]?.stringValue ?? "", description: $0["description"]?.stringValue ?? "")
            },
            multiSelect: q["multiSelect"]?.boolValue ?? false
        )
    }
}

/// 权限/提问卡。onDecision(allow, message, remember)；AskUserQuestion 走 (false, 答案文本, nil)（web 端同款协议）。
struct PermCard: View {
    let perm: PendingPerm
    let submitted: Bool
    let onDecision: (_ allow: Bool, _ message: String?, _ remember: String?) -> Void

    var body: some View {
        let ask = AskQuestion.parse(perm)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                StatusDot(color: OW.warn)
                Text(ask != nil ? "agent 提问" : "权限请求：\(perm.toolName)").font(.owLabel).foregroundStyle(OW.warn)
            }
            Text((ask?.question.isEmpty == false ? ask!.question : perm.brief)).listBody()
            if submitted {
                Text("已提交").font(.owBodyS).foregroundStyle(OW.success)
            } else if let ask {
                AskOptions(ask: ask) { onDecision(false, $0, nil) }
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        Button("批准") { Haptics.action(); onDecision(true, nil, nil) }
                            .buttonStyle(.borderedProminent).tint(OW.success)
                        Button("总是（本会话）") { Haptics.tap(); onDecision(true, nil, "session") }
                            .buttonStyle(.bordered)
                        Button("拒绝") { Haptics.warning(); onDecision(false, nil, nil) }
                            .buttonStyle(.bordered).tint(OW.danger)
                    }
                    .font(.owLabel)
                }
            }
        }
        .padding(12)
        .background(OW.surface2, in: RoundedRectangle(cornerRadius: OWRadius.l))
        .padding(.horizontal, 12).padding(.vertical, 4)
    }
}

private struct AskOptions: View {
    let ask: AskQuestion
    let onAnswer: (String) -> Void
    @State private var selected: Set<String> = []
    @State private var freeText = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(ask.options, id: \.self) { opt in
                let isSel = selected.contains(opt.label)
                Button {
                    Haptics.selection()
                    if ask.multiSelect {
                        if isSel { selected.remove(opt.label) } else { selected.insert(opt.label) }
                    } else { onAnswer(opt.label) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(opt.label).listBody().foregroundStyle(isSel ? OW.accent : OW.text)
                        if !opt.description.isEmpty { Text(opt.description).caption() }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(isSel ? OW.accent.opacity(0.18) : OW.surface1, in: RoundedRectangle(cornerRadius: OWRadius.m))
                }
                .buttonStyle(.plain)
            }
            if ask.multiSelect, !selected.isEmpty {
                Button("确认所选") { Haptics.action(); onAnswer(selected.sorted().joined(separator: "、")) }
                    .buttonStyle(.borderedProminent)
            }
            HStack {
                TextField("自定义回答…", text: $freeText).font(.owBodyS).textFieldStyle(.roundedBorder)
                Button("回答") {
                    let t = freeText.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !t.isEmpty { Haptics.action(); onAnswer(t) }
                }
                .font(.owLabel)
                .disabled(freeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }
}

// MARK: - 任务会话消息

/// ChatGPT 式语法：用户消息是右侧中性灰「请求标签」，助手回复是无气泡直排文档
struct UserBubble: View {
    let text: String
    var body: some View {
        Text(text).messageBody()
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(OW.userBubble, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

struct DevMessageRow: View {
    let msg: DevMsg
    let client: OwnwardClient

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if msg.role == "tool", msg.name == "image" {
                MsgImages(paths: msg.images, client: client)   // 图片行：agent 截图/读图，不折叠进工具行
            } else {
                // 每条消息都长按可复制（含 agent 还在输出的那条——见 copyOnLongPress）
                switch msg.role {
                case "user":
                    HStack { Spacer(minLength: 56); UserBubble(text: msg.text).copyOnLongPress(msg.text) }
                        .padding(.trailing, 16).padding(.vertical, 8)
                case "assistant":
                    MarkdownText(text: msg.text).padding(.horizontal, 16).padding(.vertical, 8)
                        .copyOnLongPress(msg.text)
                case "tool":
                    ToolRow(name: msg.toolLabel, text: msg.text)
                default: // system / thinking
                    Text(msg.text).caption().padding(.horizontal, 16).padding(.vertical, 3)
                        .copyOnLongPress(msg.text)
                }
                MsgImages(paths: msg.images, client: client)
            }
        }
    }
}

// MARK: - 连续工具调用折叠

// 分组规则（FeedItem / foldToolRuns / toolRunSubtitle）在 Feed.swift——那边不碰 SwiftUI，能直接跑单测

/// 会话流一项的渲染入口。live = 这是流的末尾且本轮还在跑（调用方按最后一项判断）。
struct FeedRow: View {
    let item: FeedItem
    let live: Bool
    let client: OwnwardClient

    var body: some View {
        switch item {
        case .one(_, let msg): DevMessageRow(msg: msg, client: client)
        case .tools(_, let msgs): ToolRunGroup(msgs: msgs, live: live)
        }
    }
}

/// 折叠起来的一段工具调用。
/// 收起时只说「跑到第几步、有没有出错」，展开才是原来那一条条的明细。
/// 出错条数单独标红摆在标题上：折叠可以省掉过程，但不能把失败一起藏了。
struct ToolRunGroup: View {
    let msgs: [DevMsg]
    let live: Bool
    @State private var open = false

    private var detail: String { msgs.map { "\($0.toolLabel) \($0.text)".trimmingCharacters(in: .whitespaces) }.joined(separator: "\n") }

    var body: some View {
        let errors = msgs.filter(\.isToolError).count
        let subtitle = toolRunSubtitle(msgs, live: live)
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { open.toggle() }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(live ? "⚙ 正在执行 · 第 \(msgs.count) 步" : "⚙ 执行了 \(msgs.count) 步")
                            .font(.owBodyS).foregroundStyle(OW.textDim)
                        if errors > 0 {
                            Text("· \(errors) 处出错").font(.owBodyS).foregroundStyle(OW.danger)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: open ? "chevron.up" : "chevron.down")
                            .font(.system(size: 12, weight: .semibold)).foregroundStyle(OW.textDim)
                    }
                    if !open, !subtitle.isEmpty {
                        Text(subtitle).font(.owMonoS).foregroundStyle(OW.textDim.opacity(0.65)).lineLimit(1)
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // 长按复制整段明细（收起状态下也能复制，不用先展开）
            .copyOnLongPress(self.detail)
            .background(OW.surface2, in: RoundedRectangle(cornerRadius: OWRadius.m))
            .overlay(RoundedRectangle(cornerRadius: OWRadius.m).strokeBorder(OW.outlineFaint, lineWidth: 1))
            .padding(.horizontal, 16).padding(.vertical, 4)
            // 明细走原来的 ToolRow：每条仍可单独展开看完整输出，展开态的样子和没折叠时一模一样
            if open {
                ForEach(Array(msgs.enumerated()), id: \.offset) { _, m in
                    ToolRow(name: m.toolLabel, text: m.text)
                }
            }
        }
        .accessibilityLabel(open ? "收起明细" : "展开明细")
    }
}

struct MsgImages: View {
    let paths: [String]?
    let client: OwnwardClient
    var body: some View {
        if let paths, !paths.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(paths, id: \.self) { p in
                        AuthedImage(url: client.absURL(p), client: client)
                            .frame(maxHeight: 240)
                            .clipShape(RoundedRectangle(cornerRadius: OWRadius.m))
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 4)
            }
        }
    }
}

/// 带 Bearer 的图片（AsyncImage 不能加 header）
struct AuthedImage: View {
    let url: URL
    let client: OwnwardClient
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                RoundedRectangle(cornerRadius: OWRadius.m).fill(OW.surface2)
                    .frame(width: 96, height: 96)
                    .overlay { if failed { Image(systemName: "photo").foregroundStyle(OW.textDim) } else { ProgressView().controlSize(.small) } }
            }
        }
        .task(id: url) {
            do {
                let data = try await client.imageData(url)
                image = UIImage(data: data)
                failed = image == nil
            } catch { failed = true }
        }
    }
}

struct ToolRow: View {
    let name: String
    let text: String
    @State private var open = false

    var body: some View {
        let firstLine = String((text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first ?? "").prefix(80))
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Text("⚙ \(name)").font(.owMono).foregroundStyle(OW.textDim)
                    Text(firstLine).font(.owBodyS).foregroundStyle(OW.textDim.opacity(0.7)).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // 点开/收起照旧；长按标题行复制整段工具输出（折叠状态下也能复制，不用先展开）。
            // 展开后的正文那块留给 textSelection——两块区域各管一种手势，不互相抢
            .copyOnLongPress(self.text)
            if open {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(text).font(.owMonoS).lineSpacing(4).padding(8).textSelection(.enabled)
                }
                .background(OW.surface2, in: RoundedRectangle(cornerRadius: OWRadius.xs))
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 2)
    }
}

struct PlanStrip: View {
    let plan: [PlanStep]
    @State private var open = false

    var body: some View {
        if !plan.isEmpty {
            let done = plan.filter { $0.status == "completed" }.count
            let current = plan.first { $0.status == "in_progress" }?.text
                ?? plan.first { $0.status == "pending" }?.text ?? "全部完成"
            Button {
                withAnimation(.snappy(duration: 0.2)) { open.toggle() }
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text("▶ \(current) · \(done)/\(plan.count)").font(.owBodyS).foregroundStyle(OW.accent).lineLimit(1)
                    if open {
                        ForEach(Array(plan.enumerated()), id: \.offset) { _, step in
                            Text((step.status == "completed" ? "☑ " : step.status == "in_progress" ? "▶ " : "☐ ") + step.text)
                                .font(.owBodyS)
                                .foregroundStyle(step.status == "completed" ? OW.textDim : OW.text)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}

/// 排队中的消息：贴在输入框正上方。
/// 放会话顶部（原来的位置）等于没放——那儿在滚动内容的最上头，人正盯着底部等回复，
/// 根本看不见自己刚发的那条还卡在队里。队列讲的就是「我刚发的还没轮到」，得挨着输入框。
struct QueuedStrip: View {
    let queued: [QueuedView]
    /// 撤回其中一条（服务端按 id 撤，撤不到会报错）；nil = 这个页面不给撤
    var onCancel: ((QueuedView) -> Void)?

    var body: some View {
        if !queued.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text("排队中 \(queued.count) 条 · 本轮结束自动发出")
                    .font(.owLabelS).foregroundStyle(OW.textDim).padding(.leading, 4)
                ForEach(Array(queued.enumerated()), id: \.offset) { _, q in
                    HStack(spacing: 4) {
                        Text(q.text.isEmpty ? (q.images > 0 ? "\(q.images) 张图片" : "（空）") : q.text)
                            .font(.owBodyS).foregroundStyle(OW.text)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 4)
                        if !q.text.isEmpty, q.images > 0 {
                            Text("+\(q.images) 图").font(.owLabelS).foregroundStyle(OW.textDim)
                        }
                        // 撤回按 q.id 走。老 daemon 不带 id，撤不了——那就不画钮，不摆假按钮
                        if let onCancel, !q.id.isEmpty {
                            Button { Haptics.tap(); onCancel(q) } label: {
                                Image(systemName: "xmark").font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(OW.textDim).frame(width: 30, height: 30)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("撤回这条")
                        }
                    }
                    .padding(.leading, 12).padding(.trailing, 4)
                    .background(OW.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(OW.outlineFaint, lineWidth: 1))
                }
            }
            .padding(.horizontal, 8).padding(.bottom, 6)
        }
    }
}

// MARK: - 一次性提示（android 那边的 snackbar）

/// 浮在底部的一次性提示。不能挂在 ErrorBanner 上：会话页 2.5s 一轮轮询，refresh 成功就把
/// error 清空，挂上去的提示活不过一次轮询，根本来不及读。点一下即消，否则 4.5s 后自动收。
private struct ToastModifier: ViewModifier {
    @Binding var message: String?

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if let message {
                Text(message)
                    .font(.owBodyS).foregroundStyle(OW.text)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .glassEffect(.regular, in: Capsule())
                    .padding(.horizontal, 24).padding(.bottom, 12)
                    .onTapGesture { withAnimation(.snappy) { self.message = nil } }
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                    .task(id: message) {
                        try? await Task.sleep(for: .seconds(4.5))
                        guard !Task.isCancelled else { return }
                        withAnimation(.snappy) { self.message = nil }
                    }
            }
        }
        .animation(.snappy, value: message)
    }
}

extension View {
    func toast(_ message: Binding<String?>) -> some View { modifier(ToastModifier(message: message)) }
}

/// Runner 不可达时服务端回 stale 快照——必须可见，否则对着过期数据以为 agent 在干活
struct StaleBanner: View {
    let errorCode: String?
    var body: some View {
        Text("⚠ 数据可能过期（Runner 不可达\(errorCode.map { "：\($0)" } ?? "")）")
            .font(.owLabelS).foregroundStyle(OW.danger)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16).padding(.vertical, 2)
    }
}
