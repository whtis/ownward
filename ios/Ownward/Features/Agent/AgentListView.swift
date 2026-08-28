// Agent tab：运行中 / 任务 两段（分区名与侧边栏对齐，同一批数据不该有两个叫法）。
// 只展示 Ownward 任务；terminal 任务仍可进入旁观/接管页（android 8acdae6 同口径）。
// 搜索走 iOS 原生 .searchable，过滤口径与侧边栏共用 searchHit——同一个关键字两处得到同一批结果。
// 右上角「+」派新任务。
import SwiftUI

struct AgentListView: View {
    let client: OwnwardClient
    let openTask: (String) -> Void
    let openTerminal: (_ taskId: String, _ ccId: String?) -> Void
    let openDispatch: () -> Void

    @State private var sessions: [RecentSession] = []
    @State private var tasks: [WorkTask] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var query = ""

    private var q: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        let running = sessions.filter { $0.status == "running" && searchHit(q, $0.title, $0.project, $0.last) }
        let rest = sessions.filter { $0.status != "running" && searchHit(q, $0.title, $0.project, $0.last) }
        let terminalRunning = tasks.filter {
            $0.status == "running" && $0.mode == "terminal" && searchHit(q, $0.title, $0.project, $0.task)
        }
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ErrorBanner(message: error)
                if !running.isEmpty || !terminalRunning.isEmpty {
                    SectionHeader(text: "运行中")
                    ForEach(running) { s in
                        EntityRow(
                            title: rowTitle(s.title, s.last, "会话"),
                            sub: sessionSub(s.project, engineLabel(s.mode, backend: s.backend, providerId: s.providerId), TimeFormat.ago(epochMs: s.lastAt)),
                            dot: OW.success
                        ) { openTask(s.id) }
                    }
                    // terminal 任务在 Mac 的 Terminal 窗口里跑：手机只能旁观底层会话，或接管到引擎
                    ForEach(terminalRunning) { t in
                        EntityRow(
                            title: rowTitle(t.title ?? "", t.task, "任务"),
                            sub: sessionSub(t.project, "terminal", TimeFormat.ago(iso: t.startedAt)),
                            dot: OW.success
                        ) { openTerminal(t.id, t.ccSessionId) }
                    }
                }
                if !rest.isEmpty {
                    SectionHeader(text: "任务")
                    ForEach(rest) { s in
                        EntityRow(
                            title: rowTitle(s.title, s.last, "会话"),
                            sub: sessionSub(s.project, engineLabel(s.mode, backend: s.backend, providerId: s.providerId), TimeFormat.ago(epochMs: s.lastAt)),
                            dot: s.status == "done" ? OW.accent : OW.textDim
                        ) { openTask(s.id) }
                    }
                }
                if loaded, running.isEmpty, rest.isEmpty, terminalRunning.isEmpty, error == nil {
                    EmptyHint(text: q.isEmpty ? "还没有 agent 会话，点右上角派一个" : "没有匹配「\(q)」的任务或会话")
                }
                Spacer(minLength: 24)
            }
            .padding(.top, 4)
            .animation(.snappy, value: sessions)
        }
        .background(OW.bg)
        .navigationTitle("Agent")
        .searchable(text: $query, prompt: "搜索任务、会话")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { DrawerMenuButton() }
            ToolbarItem(placement: .topBarTrailing) {
                Button { Haptics.tap(); openDispatch() } label: { Image(systemName: "plus") }
                    .accessibilityLabel("新任务")
            }
        }
        .refreshable { Haptics.tap(); await refresh(); await refreshAux() }
        .poll(id: "agent-list") { await refresh(); return .seconds(30) }
        // terminal 任务表是慢数据，60s 一轮；失败不打扰主列表
        .poll(id: "agent-aux") { await refreshAux(); return .seconds(60) }
    }

    private func rowTitle(_ first: String, _ second: String, _ fallback: String) -> String {
        if !first.isEmpty { return first }
        return second.isEmpty ? fallback : second
    }

    private func refresh() async {
        do { sessions = try await client.recentSessions(); error = nil }
        catch { self.error = error.userMessage }
        loaded = true
    }

    private func refreshAux() async {
        if let t = try? await client.tasks() { tasks = t }
    }
}
