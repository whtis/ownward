// 收件箱：今日会议条、等你决定（运行中任务的权限/提问）、agent 状态、例行、行动卡。
import SwiftUI

struct TaskPerm: Identifiable, Equatable {
    let taskId: String
    let project: String
    let perm: PendingPerm
    var id: String { perm.requestId }
}

@MainActor @Observable
final class InboxStore {
    let client: OwnwardClient
    var meetings: [Meeting] = []
    var perms: [TaskPerm] = []
    var attention: [AttentionItem] = []
    var routines: [RoutineCard] = []
    var actions: [ActionItem] = []
    var error: String?
    var submitted: Set<String> = []
    var loadedOnce = false

    init(client: OwnwardClient) { self.client = client }

    var isEmpty: Bool { loadedOnce && perms.isEmpty && attention.isEmpty && actions.isEmpty && routines.isEmpty }

    func refresh() async {
        do {
            async let actions = client.actions()
            async let attention = client.attention()
            async let routines = client.routines()
            async let tasks = client.tasks()
            let running = try await tasks.filter { $0.status == "running" && $0.mode != "terminal" }
            let perms: [TaskPerm] = await withTaskGroup(of: [TaskPerm].self) { group in
                for t in running {
                    group.addTask { [client] in
                        guard let s = try? await client.devMessages(id: t.id) else { return [] }
                        return s.pending.map { TaskPerm(taskId: t.id, project: t.project, perm: $0) }
                    }
                }
                var out: [TaskPerm] = []
                for await p in group { out += p }
                return out.sorted { $0.perm.at < $1.perm.at }
            }
            let newPerms = perms
            if !newPerms.isEmpty, Set(newPerms.map(\.id)) != Set(self.perms.map(\.id)), loadedOnce { Haptics.warning() }
            self.actions = try await actions.filter { $0.state == "open" || $0.state == "snoozed" }
            self.attention = try await attention
            self.routines = try await routines.filter { $0.isToday || $0.overdue || $0.hasDraft }
            self.perms = newPerms
            error = nil
            loadedOnce = true
        } catch {
            self.error = error.userMessage
        }
    }

    func refreshMeetings() async {
        if let m = try? await client.calendarToday() { meetings = m }
    }

    func decide(_ tp: TaskPerm, allow: Bool, message: String?, remember: String?) async {
        submitted.insert(tp.id)
        do { _ = try await client.devDecision(id: tp.taskId, requestId: tp.perm.requestId, allow: allow, message: message, remember: remember) }
        catch { self.error = error.userMessage }
        await refresh()
    }

    func act(_ a: ActionItem, state: String, snoozeMin: Int? = nil) async {
        withAnimation(.snappy) { actions.removeAll { $0.id == a.id } }   // 乐观移除，刷新会校正
        _ = try? await client.actionState(id: a.id, state: state, snoozeMin: snoozeMin)
        await refresh()
    }
}

struct InboxView: View {
    let client: OwnwardClient
    let openTask: (String) -> Void
    let openChat: (String) -> Void
    let openSettings: () -> Void
    @State private var store: InboxStore
    @Environment(\.openURL) private var openURL

    init(client: OwnwardClient, openTask: @escaping (String) -> Void, openChat: @escaping (String) -> Void, openSettings: @escaping () -> Void) {
        self.client = client; self.openTask = openTask; self.openChat = openChat; self.openSettings = openSettings
        _store = State(initialValue: InboxStore(client: client))
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ErrorBanner(message: store.error)
                if !store.meetings.isEmpty { MeetingStrip(meetings: store.meetings) }
                if !store.perms.isEmpty {
                    SectionHeader(text: "等你决定")
                    ForEach(store.perms) { tp in
                        VStack(alignment: .leading, spacing: 0) {
                            Button { openTask(tp.taskId) } label: {
                                Text(tp.project).font(.owLabelS).foregroundStyle(OW.textDim)
                                    .padding(.leading, 16).padding(.top, 4)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            PermCard(perm: tp.perm, submitted: store.submitted.contains(tp.id)) { allow, msg, rem in
                                Task { await store.decide(tp, allow: allow, message: msg, remember: rem) }
                            }
                        }
                    }
                }
                if !store.attention.isEmpty {
                    SectionHeader(text: "agent 状态")
                    ForEach(store.attention) { item in AttentionRow(item: item, openTask: openTask) }
                }
                if !store.routines.isEmpty {
                    SectionHeader(text: "例行")
                    ForEach(store.routines) { r in RoutineRow(routine: r, client: client) { Task { await store.refresh() } } }
                }
                if !store.actions.isEmpty {
                    SectionHeader(text: "行动卡")
                    ForEach(store.actions) { a in
                        ActionCard(action: a, openTask: openTask, openChat: openChat,
                                   onState: { st, min in Task { await store.act(a, state: st, snoozeMin: min) } })
                    }
                }
                if store.isEmpty { EmptyHint(text: "没有需要处理的事项") }
                Spacer(minLength: 24)
            }
            .padding(.top, 4)
            .animation(.snappy, value: store.perms)
            .animation(.snappy, value: store.actions)
        }
        .background(OW.bg)
        .navigationTitle("收件箱")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { DrawerMenuButton() }
            ToolbarItem(placement: .topBarTrailing) {
                Button { Haptics.tap(); Task { await store.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("刷新")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { openSettings() } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("设置")
            }
        }
        .refreshable { Haptics.tap(); await store.refresh() }
        // 会议单独拉：lark-cli 可能要 30s，别拖住主刷新
        .poll(id: "inbox-meetings") { await store.refreshMeetings(); return .seconds(300) }
        .poll(id: "inbox") { await store.refresh(); return .seconds(60) }
    }
}

private struct MeetingStrip: View {
    let meetings: [Meeting]
    @Environment(\.openURL) private var openURL
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(meetings.enumerated()), id: \.offset) { _, m in
                    Button {
                        if let s = m.meetingUrl, let u = URL(string: s) { Haptics.tap(); openURL(u) }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(TimeFormat.clock(m.start))–\(TimeFormat.clock(m.end))").font(.owLabelS).foregroundStyle(OW.accent)
                            Text(m.title).font(.owBodyS).foregroundStyle(OW.text).lineLimit(1)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(OW.surface1, in: RoundedRectangle(cornerRadius: OWRadius.m))
                    }
                    .buttonStyle(.plain)
                    .disabled(m.meetingUrl?.isEmpty ?? true)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 6)
        }
    }
}

private struct AttentionRow: View {
    let item: AttentionItem
    let openTask: (String) -> Void
    var body: some View {
        Button { openTask(item.taskId) } label: {
            HStack(spacing: 10) {
                StatusDot(color: item.kind == "stuck" ? OW.warn : OW.success)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(item.project) · \(item.title)").listBody().foregroundStyle(OW.text).lineLimit(1)
                    Text(item.detail).caption().lineLimit(2)
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .background(OW.surface1, in: RoundedRectangle(cornerRadius: OWRadius.m))
            .padding(.horizontal, 12).padding(.vertical, 3)
        }
        .buttonStyle(.plain)
    }
}

private struct RoutineRow: View {
    let routine: RoutineCard
    let client: OwnwardClient
    let onChanged: () -> Void
    var body: some View {
        let r = routine
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(r.name).listBody()
                Text(statusText).font(.owBodyS).foregroundStyle(r.overdue ? OW.warn : OW.textDim)
            }
            Spacer()
            switch r.status {
            case "pending":
                Button("生成草稿") { Haptics.tap(); Task { _ = try? await client.routineGenerate(id: r.id); onChanged() } }.font(.owLabel)
            case "draft":
                Button("写入") { Haptics.action(); Task { _ = try? await client.routineWrite(id: r.id, date: r.date); onChanged() } }.font(.owLabel)
                Button("跳过") { Haptics.tap(); Task { _ = try? await client.routineSkip(id: r.id, date: r.date); onChanged() } }
                    .font(.owLabel).foregroundStyle(OW.textDim)
            default: EmptyView()
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(OW.surface1, in: RoundedRectangle(cornerRadius: OWRadius.m))
        .padding(.horizontal, 12).padding(.vertical, 3)
    }
    private var statusText: String {
        switch routine.status {
        case "pending": routine.overdue ? "已到期，待生成" : "今天 \(routine.time)"
        case "draft": "草稿待审" + (routine.stale ? "（已过期）" : "")
        case "writing": "正在写入…"
        case "written": "已写入"
        case "skipped": "已跳过"
        default: routine.nextLabel
        }
    }
}

private struct ActionCard: View {
    let action: ActionItem
    let openTask: (String) -> Void
    let openChat: (String) -> Void
    let onState: (_ state: String, _ snoozeMin: Int?) -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        let a = action
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(a.kindLabel).font(.owLabelS).foregroundStyle(OW.accent)
                Text(a.source).font(.owLabelS).foregroundStyle(OW.textDim)
                Spacer()
                if a.state == "snoozed" { Text("已暂缓").font(.owLabelS).foregroundStyle(OW.warn) }
            }
            Text(a.title).listBody()
            if !a.reason.isEmpty { Text(a.reason).caption() }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 14) {
                    if let id = a.ref.task_id { Button("看任务") { openTask(id) } }
                    // lark 类 Action 的 chat_id 是飞书会话 id，不是 AI 对话——当对话打开只会 404
                    if let id = a.ref.chat_id, a.source != "lark" { Button("看对话") { openChat(id) } }
                    if let s = a.ref.url, s.hasPrefix("http"), let u = URL(string: s) { Button("打开链接") { openURL(u) } }
                    Spacer(minLength: 12)
                    Button("完成") { Haptics.success(); onState("resolved", nil) }.foregroundStyle(OW.success)
                    Button("暂缓") { Haptics.tap(); onState("snoozed", 120) }
                    Button("忽略") { Haptics.tap(); onState("dismissed", nil) }.foregroundStyle(OW.textDim)
                }
                .font(.owLabel)
                .buttonStyle(.plain)
                .padding(.vertical, 6)
            }
        }
        .padding(12)
        .background(OW.surface1, in: RoundedRectangle(cornerRadius: OWRadius.l))
        .padding(.horizontal, 12).padding(.vertical, 3)
    }
}
