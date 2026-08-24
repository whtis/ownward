// 旁观 + 接管（对齐 web/tasks.js 的 pollCcObserve / adoptCc / adoptTerminal，android ui/ObserveScreen.kt）。
// 两种入口：
//  - 外部会话（ccId）：本机 Terminal/clawd 跑的 Claude 或 Codex 会话，只读增量跟读；
//    「接管续聊」= 签凭证 → 接管成 ownward 任务
//  - terminal 任务（taskId）：ownward 派到 Terminal 窗口的任务，底层 Claude 会话 id 由服务端认领；
//    「接管到引擎」一步到位
// 接管成功后 onAdopted(新任务 id)，调用方直接跳会话页续聊。
import SwiftUI

@MainActor @Observable
final class ObserveStore {
    let client: OwnwardClient
    let ccId: String?
    let taskId: String?

    var sessionId: String?
    var meta: ObservedSession?
    var msgs: [DevMsg] = []
    var offset: Int64 = 0
    var truncated = false
    var error: String?
    var adopting = false
    var loaded = false
    private var grewLast = false

    var isTerminal: Bool { !(taskId ?? "").isEmpty }

    init(client: OwnwardClient, ccId: String?, taskId: String?) {
        self.client = client; self.ccId = ccId; self.taskId = taskId
        sessionId = (ccId?.isEmpty == false) ? ccId : nil
    }

    /// 会话元数据（项目名/标题/是否活跃）是慢数据，60s 一轮；列表里找不到（掉出窗口）也不影响跟读
    func refreshMeta() async {
        guard let id = sessionId else { return }
        if let hit = try? await client.ccSessions().first(where: { $0.id == id }) { meta = hit }
    }

    /// 消息增量跟读：活跃会话 2.5s，空闲 8s（web 同款 cadence）
    func refresh() async -> Duration {
        do {
            // terminal 任务的底层会话以服务端认领为准：列表里带来的 ccSessionId 只是初值，
            // 还没认领到 / 上一轮读失败（链接失效被服务端重认）时都向服务端重问，id 变了就从头读
            if isTerminal, sessionId == nil || error != nil, let tid = taskId {
                let r = try await client.taskCcSession(taskId: tid)
                if r.ok, let sid = r.sessionId, !sid.isEmpty, sid != sessionId {
                    sessionId = sid
                    offset = 0; msgs = []; truncated = false
                }
            }
            if let id = sessionId {
                let page = try await client.ccSession(id: id, after: offset)
                if !page.isOK, page.messages.isEmpty {
                    error = page.msg.isEmpty ? "会话读取失败" : page.msg
                } else {
                    // 首帧 / 文件缩小（offset 回退）= 截断重建：清空累积再并
                    if offset == 0 || page.offset < offset {
                        msgs = page.messages
                        truncated = page.truncated
                    } else if !page.messages.isEmpty {
                        msgs += page.messages
                    }
                    grewLast = !page.messages.isEmpty
                    offset = page.offset
                    error = nil
                }
            }
            loaded = true
        } catch {
            self.error = error.userMessage
        }
        return (meta?.active == true || grewLast) ? .milliseconds(2500) : .seconds(8)
    }

    /// 接管：外部会话走「签凭证 → 接管」两步，terminal 任务一步到位。返回新任务 id
    func adopt() async -> String? {
        guard !adopting else { return nil }
        adopting = true
        defer { adopting = false }
        do {
            let r: DispatchResult
            if isTerminal, let tid = taskId {
                r = try await client.adoptTerminal(taskId: tid)
            } else {
                guard let id = sessionId else { error = "会话还没就绪"; return nil }
                let cap = try await client.ccAdoptCapability(id: id)
                guard cap.ok, let token = cap.adoptToken, !token.isEmpty else {
                    error = cap.msg.isEmpty ? "无法签发接管凭证" : cap.msg
                    Haptics.error()
                    return nil
                }
                r = try await client.ccAdopt(id: id, adoptToken: token)
            }
            guard r.ok else { error = r.msg; Haptics.error(); return nil }
            guard let newId = r.taskId else {
                error = r.msg.isEmpty ? "已接管，但没拿到新会话 id" : r.msg
                return nil
            }
            Haptics.success()
            return newId
        } catch {
            self.error = error.userMessage; Haptics.error()
            return nil
        }
    }
}

struct ObserveView: View {
    let client: OwnwardClient
    let ccId: String?
    let taskId: String?
    let onAdopted: (String) -> Void
    @State private var store: ObserveStore

    init(client: OwnwardClient, ccId: String?, taskId: String?, onAdopted: @escaping (String) -> Void) {
        self.client = client; self.ccId = ccId; self.taskId = taskId; self.onAdopted = onAdopted
        _store = State(initialValue: ObserveStore(client: client, ccId: ccId, taskId: taskId))
    }

    var body: some View {
        // 连续工具调用折成一组（和任务会话同一套）：旁观的是别人正在跑的会话，工具流只会更长。
        // 这里没有 turn 状态可判，一律按「已执行」收起
        let feed = foldToolRuns(store.msgs)
        ConversationScroll(followKey: store.msgs.count) {
            if store.truncated {
                Text("（长会话已截断前文）").font(.owLabelS).foregroundStyle(OW.textDim)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(16)
            }
            ForEach(feed) { item in FeedRow(item: item, live: false, client: client) }
            if store.msgs.isEmpty { EmptyHint(text: emptyText) }
            Spacer(minLength: 8)
        }
        .background(OW.bg)
        .safeAreaBar(edge: .top) {
            VStack(alignment: .leading, spacing: 0) {
                if let t = store.meta?.title, !t.isEmpty {
                    Text(t).font(.owLabelS).foregroundStyle(OW.textDim).lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 2)
                }
                ErrorBanner(message: store.error)
            }
        }
        .safeAreaBar(edge: .bottom) { adoptBar }
        .toolbar(.hidden, for: .tabBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { DrawerMenuButton() }
            ToolbarItem(placement: .principal) {
                HStack(spacing: 8) {
                    StatusDot(color: store.meta?.active == true ? OW.success : OW.textDim)
                    // 项目名可能是超长 hash 目录名（cwd 缺失时的服务端回落），单行省略
                    Text("\(projectLabel) · \(engineName) · 旁观").font(.owTitleS).lineLimit(1)
                }
            }
        }
        .poll(id: "observe-meta-\(ccId ?? "")-\(taskId ?? "")") { await store.refreshMeta(); return .seconds(60) }
        .poll(id: "observe-\(ccId ?? "")-\(taskId ?? "")") { await store.refresh() }
    }

    private var projectLabel: String {
        if let p = store.meta?.project, !p.isEmpty { return p }
        return store.isTerminal ? "terminal" : "会话"
    }
    private var engineName: String { store.meta?.isCodex == true ? "codex" : "claude" }

    private var emptyText: String {
        if !store.loaded { return "正在载入会话…" }
        if store.sessionId == nil, store.isTerminal {
            return "terminal 任务在 Terminal 窗口里跑，还没认领到底层 Claude 会话（稍等）"
        }
        return "会话暂无内容"
    }

    private var adoptBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(hint)
                .font(.owLabelS)
                .foregroundStyle(store.meta?.active == true ? OW.warn : OW.textDim)
            Button {
                Task { if let id = await store.adopt() { onAdopted(id) } }
            } label: {
                HStack {
                    Spacer()
                    if store.adopting {
                        ProgressView().controlSize(.small)
                        Text("正在接管…").padding(.leading, 8)
                    } else {
                        Text(store.isTerminal ? "接管到引擎" : "接管续聊")
                    }
                    Spacer()
                }
                .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .disabled(store.adopting || (store.sessionId == nil && !store.isTerminal))
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    private var hint: String {
        if store.meta?.active == true { return "会话正被其他端驱动（2 分钟内有写入），空闲后才能接管" }
        if store.isTerminal { return "接管后 Terminal 任务收尾，会话转由 ownward 引擎续聊（Terminal 里的会话须已空闲）" }
        return "接管后变成 ownward 会话，可在手机上直接续聊、审批"
    }
}
