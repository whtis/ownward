// ChatGPT 式侧边栏（对齐 android ui/Sidebar.kt）：任意页面点顶栏 ☰ 拉出，带搜索，
// 任务 / 本机会话 / 对话一处选、一步切。抽屉挂在 MainShell（盖在 TabView 之上），
// 各页只通过 environment 的 openDrawer 开它。
//
// 与 android 的差异：那边左滑边缘也能拉出抽屉，iOS 不做——左边缘是系统返回手势的地盘，
// 抢过来会把 NavigationStack 的滑动返回废掉。这里只留 ☰（每页都有）+ 抽屉上向左划关闭。
import SwiftUI

/// 抽屉里能去的地方；MainShell 翻译成 tab + 路由（详情类互相切换时替换当前详情页，返回栈不长高）
enum DrawerDest: Hashable, Sendable {
    case inbox, newChat, newTask, settings
    case task(String)
    case chat(String)
    case observe(String)                       // 外部会话 id
    case terminal(taskId: String, ccId: String?)

    /// 与 MainShell 算出的「当前页键」同一套字符串，用来高亮当前项 / 点到当前项时不重载
    var key: String {
        switch self {
        case .inbox: "inbox"
        case .newChat: "chat:new"
        case .newTask: "dispatch"
        case .settings: "settings"
        case .task(let id): "task:\(id)"
        case .chat(let id): "chat:\(id)"
        case .observe(let id): "observe:\(id)"
        case .terminal(let taskId, _): "terminal:\(taskId)"
        }
    }
}

extension EnvironmentValues {
    /// MainShell 提供；shell 外（Setup 页）为 nil，顶栏的 ☰ 就不画
    @Entry var openDrawer: (@MainActor () -> Void)?
}

/// 顶栏左侧的 ☰；抽屉不可用时不画
struct DrawerMenuButton: View {
    @Environment(\.openDrawer) private var openDrawer
    var body: some View {
        if let openDrawer {
            Button { Haptics.tap(); openDrawer() } label: { Image(systemName: "line.3.horizontal") }
                .accessibilityLabel("菜单")
        }
    }
}

/// 抽屉四张表，各自 try? ——一张失败不拖累其他；抽屉常驻视图树，关了再开先显旧的再刷新
@MainActor @Observable
final class DrawerData {
    var sessions: [RecentSession] = []
    var tasks: [WorkTask] = []
    var ccList: [ObservedSession] = []
    var chats: [AiChat] = []
    var loaded = false

    func refresh(_ client: OwnwardClient) async {
        async let s = try? client.recentSessions()
        async let t = try? client.tasks()
        async let c = try? client.ccSessions()
        async let ch = try? client.chatList()
        if let v = await s { sessions = v }
        if let v = await t { tasks = v }
        if let v = await c { ccList = v }
        if let v = await ch { chats = v }
        loaded = true
    }
}

/// 抽屉内容。isOpen 关上即停轮询、清搜索——不能常开轮询：抽屉常驻视图树，
/// 那会在后台一直轮四张表（其中 ccSessions 要扫 ~/.claude/projects，很贵）。
struct AppDrawer: View {
    let client: OwnwardClient
    let isOpen: Bool
    let selectedKey: String?
    let onGo: (DrawerDest) -> Void

    @State private var data = DrawerData()
    @State private var searching = false
    @State private var query = ""

    private var q: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        let running = data.sessions.filter { $0.status == "running" && searchHit(q, $0.title, $0.project, $0.last) }
        let terminal = data.tasks.filter {
            $0.status == "running" && $0.mode == "terminal" && searchHit(q, $0.title, $0.project, $0.task)
        }
        let restAll = data.sessions.filter { $0.status != "running" && searchHit(q, $0.title, $0.project, $0.last) }
        let externalAll = externalSessions(tasks: data.tasks, ccList: data.ccList)
            .filter { searchHit(q, $0.title, $0.firstUser, $0.project) }
        let chatsAll = data.chats.filter { searchHit(q, $0.title, $0.provider, $0.model) }
        // 不搜索时每段只放最近几条：历史任务 40+、本机会话 100+，全铺出来底下的「对话」永远滚不到。
        // 截断必须说出来（下面的 drawerMore 行），否则看起来像「就这些」。搜索时全展开。
        let rest = q.isEmpty ? Array(restAll.prefix(12)) : restAll
        let external = q.isEmpty ? Array(externalAll.prefix(8)) : externalAll
        let chats = q.isEmpty ? Array(chatsAll.prefix(12)) : chatsAll
        let nothing = running.isEmpty && terminal.isEmpty && rest.isEmpty && external.isEmpty && chats.isEmpty

        VStack(spacing: 0) {
            header
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if q.isEmpty {
                        navItem("tray", "收件箱", selectedKey == "inbox") { onGo(.inbox) }
                        navItem("plus.square.on.square", "派新任务", selectedKey == "dispatch") { onGo(.newTask) }
                    }
                    if !running.isEmpty || !terminal.isEmpty {
                        section("运行中")
                        ForEach(running) { s in
                            EntityRow(
                                title: rowTitle(s.title, s.last, "会话"),
                                sub: sessionSub(s.project, engineLabel(s.mode), TimeFormat.ago(epochMs: s.lastAt)),
                                dot: OW.success, selected: selectedKey == "task:\(s.id)"
                            ) { onGo(.task(s.id)) }
                        }
                        ForEach(terminal) { t in
                            EntityRow(
                                title: rowTitle(t.title ?? "", t.task, "任务"),
                                sub: sessionSub(t.project, "terminal", TimeFormat.ago(iso: t.startedAt)),
                                dot: OW.success, selected: selectedKey == "terminal:\(t.id)"
                            ) { onGo(.terminal(taskId: t.id, ccId: t.ccSessionId)) }
                        }
                    }
                    if !rest.isEmpty {
                        section("任务")
                        ForEach(rest) { s in
                            EntityRow(
                                title: rowTitle(s.title, s.last, "会话"),
                                sub: sessionSub(s.project, engineLabel(s.mode), TimeFormat.ago(epochMs: s.lastAt)),
                                dot: s.status == "done" ? OW.accent : OW.textDim,
                                selected: selectedKey == "task:\(s.id)"
                            ) { onGo(.task(s.id)) }
                        }
                        drawerMore(restAll.count - rest.count)
                    }
                    if !external.isEmpty {
                        section("本机会话")
                        ForEach(external) { s in
                            EntityRow(
                                title: rowTitle(s.title, s.firstUser, "会话"),
                                sub: sessionSub(s.project, s.isCodex ? "codex" : "claude", TimeFormat.ago(epochMs: s.mtime)),
                                dot: s.active ? OW.success : OW.textDim,
                                selected: selectedKey == "observe:\(s.id)"
                            ) { onGo(.observe(s.id)) }
                        }
                        drawerMore(externalAll.count - external.count)
                    }
                    if !chats.isEmpty {
                        section("对话")
                        ForEach(chats) { c in
                            EntityRow(
                                title: c.title.isEmpty ? "未命名对话" : c.title,
                                sub: sessionSub(c.provider, TimeFormat.ago(iso: c.updatedAt)),
                                selected: selectedKey == "chat:\(c.id)"
                            ) { onGo(.chat(c.id)) }
                        }
                        drawerMore(chatsAll.count - chats.count)
                    }
                    if nothing {
                        Text(!data.loaded ? "正在载入…" : (q.isEmpty ? "还没有任务和对话" : "没有匹配「\(q)」的任务或对话"))
                            .listBody().foregroundStyle(OW.textDim)
                            .padding(.horizontal, 20).padding(.vertical, 24)
                    }
                    Spacer(minLength: 8)
                }
            }
            footer
        }
        .task(id: isOpen) {
            guard isOpen else { searching = false; query = ""; return }
            while !Task.isCancelled {
                await data.refresh(client)
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    /// 标题回落链：标题 → 最后一句 → 兜底词。空字符串不算标题
    private func rowTitle(_ first: String, _ second: String, _ fallback: String) -> String {
        if !first.isEmpty { return first }
        return second.isEmpty ? fallback : second
    }

    // 头：标题 + 圆形搜索钮；点搜索原位换成搜索框（ChatGPT 同款）
    private var header: some View {
        HStack {
            if searching {
                SearchField(text: $query) { searching = false; query = "" }
            } else {
                Text("ownward").font(.owTitle).foregroundStyle(OW.text)
                Spacer()
                Button { Haptics.tap(); searching = true } label: {
                    Image(systemName: "magnifyingglass").font(.system(size: 16, weight: .medium))
                        .frame(width: 40, height: 40)
                        .background(OW.surface2, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("搜索")
            }
        }
        .frame(height: 44)
        .padding(.leading, 20).padding(.trailing, 12).padding(.top, 12).padding(.bottom, 4)
    }

    // 底：「新对话」药丸 + 设置圆钮（ChatGPT 的「聊天」+ 齿轮同位）
    private var footer: some View {
        HStack {
            Button { onGo(.newChat) } label: {
                Label("新对话", systemImage: "square.and.pencil").font(.owBodyM)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            Spacer()
            Button { onGo(.settings) } label: {
                Image(systemName: "gearshape").font(.system(size: 16, weight: .medium))
                    .frame(width: 40, height: 40)
                    .background(OW.surface2, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("设置")
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    /// 顶部快捷项（ChatGPT 的 图片/资料库 那排）：图标 + 文字
    private func navItem(_ icon: String, _ label: String, _ selected: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 16) {
                Image(systemName: icon).font(.system(size: 18)).frame(width: 22)
                Text(label).font(.owBody)
                Spacer(minLength: 0)
            }
            .foregroundStyle(OW.text)
            .padding(.horizontal, 12).padding(.vertical, 12)
            .background(selected ? OW.surface2 : Color.clear, in: RoundedRectangle(cornerRadius: OWRadius.m))
            .padding(.horizontal, 8).padding(.vertical, 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// 被截断的尾巴：明说还有多少条、去哪找，不装作「就这些」
    @ViewBuilder
    private func drawerMore(_ hidden: Int) -> some View {
        if hidden > 0 {
            Text("还有 \(hidden) 条 · 用上面的搜索找")
                .font(.owLabelS).foregroundStyle(OW.textDim)
                .padding(.horizontal, 20).padding(.top, 4).padding(.bottom, 2)
        }
    }

    private func section(_ text: String) -> some View {
        Text(text).font(.owLabel).foregroundStyle(OW.textDim)
            .padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 4)
    }
}

/// 抽屉容器：内容之上盖一层遮罩 + 从左滑入的面板。
/// 用 overlay 而不是 ZStack+GeometryReader —— 后者会把 TabView 包进一个测量容器里，
/// tab bar 的 minimize 行为和安全区计算都会走样。
struct DrawerContainer<Drawer: View, Content: View>: View {
    @Binding var isOpen: Bool
    @ViewBuilder let drawer: () -> Drawer
    @ViewBuilder let content: () -> Content

    private let width: CGFloat = 320

    var body: some View {
        content()
            .overlay {
                if isOpen {
                    Color.black.opacity(0.32).ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture { close() }
                        .transition(.opacity)
                }
            }
            .overlay(alignment: .leading) {
                drawer()
                    .frame(width: width)
                    .frame(maxHeight: .infinity)
                    .background { OW.bg.ignoresSafeArea() }
                    .overlay(alignment: .trailing) { Rectangle().fill(OW.outlineFaint).frame(width: 1).ignoresSafeArea() }
                    .offset(x: isOpen ? 0 : -(width + 12))
                    // 关上时整块挪到屏幕外：不掐掉命中测试的话，左边缘会有一条看不见的热区吃掉手势
                    .allowsHitTesting(isOpen)
                    // 抽屉上向左划关掉（和拉出来的方向相反，同一套肌肉记忆）
                    .gesture(DragGesture(minimumDistance: 20).onEnded { v in
                        if v.translation.width < -40 { close() }
                    })
            }
            .animation(.snappy(duration: 0.28), value: isOpen)
    }

    private func close() { Haptics.tap(); isOpen = false }
}
