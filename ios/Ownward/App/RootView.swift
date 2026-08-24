import SwiftUI

/// 三个 tab 各自的路由（每个 tab 一条 NavigationStack）
enum Route: Hashable, Sendable {
    case task(String)
    case chat(String?)                              // nil = 新对话
    case settings
    case dispatch                                   // 派新任务表单
    case observe(ccId: String?, taskId: String?)    // 旁观外部会话 / terminal 任务
}

enum AppTab: Hashable { case inbox, agent, chat }

struct RootView: View {
    @Environment(AppSettings.self) private var settings

    var body: some View {
        if let client = settings.client {
            MainShell(client: client).id(settings.config)   // 配置变了整棵树重建，client 跟着换
        } else {
            SetupView()
        }
    }
}

struct MainShell: View {
    let client: OwnwardClient
    @State private var tab: AppTab = .chat          // 首页=对话：打开就能聊
    @State private var inboxPath: [Route] = []
    @State private var agentPath: [Route] = []
    @State private var chatPath: [Route] = [.chat(nil)]   // 冷启动直达新对话（back 回列表）
    @State private var drawerOpen = false

    init(client: OwnwardClient) {
        self.client = client
        #if DEBUG
        // 调试直达：xcrun simctl launch <dev> ai.ownward.app -ownward.debugTab inbox -ownward.debugRoute settings
        // 再加 -ownward.debugDrawer 1 可以开着侧边栏启动（抽屉没有 URL 入口，截图/自动化只能这样进）
        // （UserDefaults 自动解析启动参数，仅当次进程有效；截图/自动化用，Release 不编译）
        let d = UserDefaults.standard
        _drawerOpen = State(initialValue: d.bool(forKey: "ownward.debugDrawer"))
        var tab: AppTab = .chat
        var chatPath: [Route] = [.chat(nil)]
        var inboxPath: [Route] = []
        var agentPath: [Route] = []
        switch d.string(forKey: "ownward.debugTab") {
        case "inbox": tab = .inbox
        case "agent": tab = .agent
        case "chat": tab = .chat; chatPath = []
        default: break
        }
        if let r = d.string(forKey: "ownward.debugRoute") {
            let route: Route? = switch r {
            case "settings": .settings
            case "newchat": .chat(nil)
            case "dispatch": .dispatch
            case "none": nil
            default: r.hasPrefix("chat:") ? .chat(String(r.dropFirst(5)))
                : (r.hasPrefix("task:") ? .task(String(r.dropFirst(5)))
                : (r.hasPrefix("observe:") ? .observe(ccId: String(r.dropFirst(8)), taskId: nil) : nil))
            }
            switch tab {
            case .inbox: inboxPath = route.map { [$0] } ?? []
            case .agent: agentPath = route.map { [$0] } ?? []
            case .chat: chatPath = route.map { [$0] } ?? []
            }
        }
        _tab = State(initialValue: tab)
        _chatPath = State(initialValue: chatPath)
        _inboxPath = State(initialValue: inboxPath)
        _agentPath = State(initialValue: agentPath)
        #endif
    }

    var body: some View {
        DrawerContainer(isOpen: $drawerOpen) {
            AppDrawer(client: client, isOpen: drawerOpen, selectedKey: currentKey) { go($0) }
        } content: {
            tabs
        }
        .environment(\.openDrawer, { Haptics.tap(); drawerOpen = true })
    }

    private var tabs: some View {
        TabView(selection: $tab) {
            Tab("收件箱", systemImage: "tray", value: .inbox) {
                NavigationStack(path: $inboxPath) {
                    InboxView(client: client, openTask: { inboxPath.append(.task($0)) },
                              openChat: { inboxPath.append(.chat($0)) },
                              openSettings: { inboxPath.append(.settings) })
                        .navigationDestination(for: Route.self) { destination($0, path: $inboxPath) }
                }
            }
            Tab("Agent", systemImage: "cpu", value: .agent) {
                NavigationStack(path: $agentPath) {
                    AgentListView(client: client,
                                  openTask: { agentPath.append(.task($0)) },
                                  openObserve: { agentPath.append(.observe(ccId: $0, taskId: nil)) },
                                  openTerminal: { agentPath.append(.observe(ccId: $1, taskId: $0)) },
                                  openDispatch: { agentPath.append(.dispatch) })
                        .navigationDestination(for: Route.self) { destination($0, path: $agentPath) }
                }
            }
            Tab("对话", systemImage: "bubble.left.and.text.bubble.right", value: .chat) {
                NavigationStack(path: $chatPath) {
                    ChatListView(client: client, openChat: { chatPath.append(.chat($0)) })
                        .navigationDestination(for: Route.self) { destination($0, path: $chatPath) }
                }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .onChange(of: tab) { Haptics.selection() }
        // 返回（按钮或边缘右滑）时的轻触感：path 变短即 pop
        .onChange(of: inboxPath.count) { old, new in if new < old { Haptics.back() } }
        .onChange(of: agentPath.count) { old, new in if new < old { Haptics.back() } }
        .onChange(of: chatPath.count) { old, new in if new < old { Haptics.back() } }
    }

    /// 侧边栏高亮用的「当前页键」，与 DrawerDest.key 同一套字符串。
    /// 新对话发出第一条后拿到的 id 只在页面内部，这里仍算 chat:new
    private var currentKey: String? {
        let top: Route? = switch tab {
        case .inbox: inboxPath.last
        case .agent: agentPath.last
        case .chat: chatPath.last
        }
        switch top {
        case .task(let id): return "task:\(id)"
        case .chat(let id): return id.map { "chat:\($0)" } ?? "chat:new"
        case .settings: return "settings"
        case .dispatch: return "dispatch"
        case .observe(let ccId, let taskId):
            if let taskId { return "terminal:\(taskId)" }
            return ccId.map { "observe:\($0)" }
        case nil: return tab == .inbox ? "inbox" : nil
        }
    }

    /// 抽屉切页不叠栈：直接把目标 tab 的栈换成单页，返回键永远一步回到列表，
    /// 否则在侧边栏里连点十个会话就攒出十层返回栈
    private func go(_ dest: DrawerDest) {
        drawerOpen = false
        guard dest.key != currentKey else { return }   // 点的就是当前页：只关抽屉，不重载
        switch dest {
        case .inbox: tab = .inbox; inboxPath = []
        case .newChat: tab = .chat; chatPath = [.chat(nil)]
        case .newTask: tab = .agent; agentPath = [.dispatch]
        case .settings: tab = .inbox; inboxPath = [.settings]
        case .task(let id): tab = .agent; agentPath = [.task(id)]
        case .chat(let id): tab = .chat; chatPath = [.chat(id)]
        case .observe(let id): tab = .agent; agentPath = [.observe(ccId: id, taskId: nil)]
        case .terminal(let taskId, let ccId): tab = .agent; agentPath = [.observe(ccId: ccId, taskId: taskId)]
        }
    }

    @ViewBuilder
    private func destination(_ route: Route, path: Binding<[Route]>) -> some View {
        switch route {
        case .task(let id): TaskDetailView(client: client, taskId: id)
        case .chat(let id): ChatDetailView(client: client, chatId: id)
        case .settings: SettingsView()
        case .dispatch:
            // 派完直接进会话（表单页出栈，back 回 Agent 列表）
            DispatchView(client: client) { id in path.wrappedValue = replacingLast(path.wrappedValue, with: .task(id)) }
        case .observe(let ccId, let taskId):
            // 接管成功直接进新会话续聊（旁观页出栈，back 回 Agent 列表）
            ObserveView(client: client, ccId: ccId, taskId: taskId) { id in
                path.wrappedValue = replacingLast(path.wrappedValue, with: .task(id))
            }
        }
    }

    /// 用新页替换栈顶（而不是 push）：表单页/旁观页办完事就该走人，别留在返回栈里
    private func replacingLast(_ stack: [Route], with route: Route) -> [Route] {
        stack.isEmpty ? [route] : stack.dropLast() + [route]
    }
}
