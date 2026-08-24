// agent 会话详情：消息流（连续工具调用折成一组）+ 计划条/stale 提示 + 权限卡
// + composer（Stop/中断、排队消息可撤回、斜杠命令补全）+ 接管租约 + 信息面板。
// 不流式（服务端按轮询给 partial），partial 走打字机平滑吐字。
import SwiftUI
import PhotosUI

@MainActor @Observable
final class TaskSessionStore {
    let client: OwnwardClient
    let taskId: String
    var state: AgentState?
    var error: String?
    /// 一次性提示（撤回失败等）。不能挂在 error 上：轮询 2.5s 一轮、refresh 成功就把 error 清空，
    /// 挂上去的提示活不过一次轮询，根本来不及读
    var notice: String?
    var submitted: Set<String> = []
    var sending = false
    let partial = TypewriterBuffer()

    init(client: OwnwardClient, taskId: String) { self.client = client; self.taskId = taskId }

    func refresh() async {
        do {
            let next = try await client.devMessages(id: taskId)
            let prev = state
            if next != prev {
                state = next
                partial.set(next.partial)
                if !next.isRunning { partial.flush() }
                if let prev {
                    if prev.isRunning, !next.isRunning { Haptics.success() }          // 一轮干完
                    if next.pending.count > prev.pending.count { Haptics.warning() }  // 新的待决
                }
            }
            error = nil
        } catch {
            self.error = error.userMessage
        }
    }

    var pollInterval: Duration { state?.isRunning == true ? .milliseconds(2500) : .seconds(8) }

    func send(text: String, images: [OutImage]) async -> Bool {
        sending = true
        defer { sending = false }
        do {
            _ = try await client.devSend(id: taskId, text: text, images: images)
            await refresh()
            return true
        } catch {
            self.error = error.userMessage; Haptics.error()
            return false
        }
    }

    func interrupt() async {
        do { _ = try await client.devInterrupt(id: taskId) } catch { self.error = error.userMessage }
        await refresh()
    }

    /// 撤不到（本轮刚结束、这条已经合并发出了）服务端回 409，原因必须让用户看见
    func cancelQueued(_ q: QueuedView) async {
        var failure: String?
        do { _ = try await client.devQueueRemove(id: taskId, queueId: q.id) }
        catch { failure = error.userMessage; Haptics.error() }
        await refresh()
        if let failure { notice = failure }
    }

    /// 接管租约：take 取回输入权 / release 交还只旁观（web「接管输入 / 释放输入权」同款）
    func setControl(_ action: String) async {
        do {
            let r = try await client.devControl(id: taskId, action: action)
            if !r.ok { error = r.msg } else { Haptics.success() }
        } catch { self.error = error.userMessage; Haptics.error() }
        await refresh()
    }

    func decide(_ perm: PendingPerm, allow: Bool, message: String?, remember: String?) async {
        submitted.insert(perm.requestId)
        do { _ = try await client.devDecision(id: taskId, requestId: perm.requestId, allow: allow, message: message, remember: remember) }
        catch { self.error = error.userMessage }
        await refresh()
    }
}

struct TaskDetailView: View {
    let client: OwnwardClient
    let taskId: String
    @State private var store: TaskSessionStore
    @State private var input = ""
    @State private var pendingImages: [PendingImage] = []
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var showInfo = false
    @FocusState private var focused: Bool

    init(client: OwnwardClient, taskId: String) {
        self.client = client; self.taskId = taskId
        _store = State(initialValue: TaskSessionStore(client: client, taskId: taskId))
    }

    private var state: AgentState? { store.state }
    private var running: Bool { state?.isRunning ?? false }

    var body: some View {
        let msgs = state?.messages ?? []
        let partial = store.partial.displayed
        let pending = state?.pending ?? []
        // 连续工具调用折成一组：一轮几十次 Edit/Bash 一条一行能把整屏铺满，
        // 而这段时间要看的只有「还在跑、第几步、有没有出错」。id 是组的起点下标——
        // 尾部那组会一直长大但起点不动，追加时旧项不换位
        let feed = foldToolRuns(msgs)
        ConversationScroll(followKey: msgs.count * 1000 + pending.count * 7 + partial.utf16.count / 40) {
            ForEach(feed) { item in
                // 最后一项就是流的末尾：本轮还在跑时，这组显示「正在执行」
                FeedRow(item: item, live: item.index == feed.last?.index && running, client: client)
            }
            if !partial.isEmpty {
                // agent 还在输出的这条同样长按可复制——复制已经吐出来的部分，不必等它写完
                StreamingMarkdown(text: partial, showCursor: running)
                    .padding(.horizontal, 16).padding(.vertical, 8)
                    .copyOnLongPress(store.partial.displayed)
            } else if running {
                HStack(spacing: 10) { ThinkingDots(); Text("agent 正在工作").caption() }
                    .padding(.horizontal, 16).padding(.vertical, 8)
            }
            ForEach(pending) { perm in
                PermCard(perm: perm, submitted: store.submitted.contains(perm.requestId)) { allow, msg, rem in
                    Task { await store.decide(perm, allow: allow, message: msg, remember: rem) }
                }
            }
            Spacer(minLength: 8)
        }
        .background(OW.bg)
        .safeAreaBar(edge: .top) { topStrips }
        .safeAreaBar(edge: .bottom) {
            ComposerBar(
                text: $input, pendingImages: $pendingImages, pickerItems: $pickerItems,
                canSend: !store.sending && (state?.canInput ?? false),
                busy: store.sending, running: running,
                queued: state?.queued ?? [],
                onCancelQueued: { q in Task { await store.cancelQueued(q) } },
                controlHint: controlHint,
                controlAction: controlAction,
                // 只有 claude 引擎会回报 slash_commands；codex 没有命令表就不开菜单（web/tasks.js 同款判断）
                commands: state?.backend == "claude" ? (state?.commands ?? []) : nil,
                onSend: { Task { await send() } },
                onInterrupt: { Task { await store.interrupt() } },
                focused: $focused
            )
        }
        .toast($store.notice)
        .toolbar(.hidden, for: .tabBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // ☰ 挨在系统返回键右边（android 是拿 ☰ 替掉返回键，iOS 不能——左边缘的滑动返回是系统契约，
            // 顶栏那颗返回键得留着跟它配对）。少了它，从会话里换一个会话就得先退回列表
            ToolbarItem(placement: .topBarLeading) { DrawerMenuButton() }
            ToolbarItem(placement: .principal) {
                HStack(spacing: 8) {
                    StatusDot(color: state == nil ? OW.textDim : (running ? OW.success : (state!.alive ? OW.accent : OW.textDim)))
                    Text(titleText).font(.owTitleS)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { Haptics.tap(); showInfo = true } label: { Image(systemName: "info.circle") }
                    .disabled(state == nil)
                    .accessibilityLabel("详情")
            }
        }
        .sheet(isPresented: $showInfo) {
            if let s = state {
                InfoSheet(state: s, setControl: { action in
                    showInfo = false
                    Task { await store.setControl(action) }
                })
                .presentationDetents([.medium])
            }
        }
        // 运行中 2.5s，空闲 8s；仅前台可见时轮询
        .poll(id: "task-\(taskId)") { await store.refresh(); return store.pollInterval }
        .task {
            #if DEBUG
            // 调试：-ownward.debugInput "/" 预填输入框，用来给斜杠补全菜单截图
            //（模拟器没法脚本化打字；截图/自动化用，Release 不编译）
            if let s = UserDefaults.standard.string(forKey: "ownward.debugInput"), !s.isEmpty { input = s }
            #endif
        }
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            Task {
                let (imgs, failed) = await PendingImage.load(items)
                pendingImages = Array((pendingImages + imgs).prefix(ImageEncoder.maxImages))
                if failed > 0 { store.error = "部分图片读取失败或超过 5MB" }
                pickerItems = []
            }
        }
        .onDisappear { store.partial.flush() }
    }

    private var titleText: String {
        if running { return "运行中" }
        if let s = state, s.control != "ownward" { return "只旁观" }
        return "会话"
    }

    private var controlHint: String? {
        guard let s = state else { return nil }
        if s.operability == "read-only" { return "会话已归档（只读）" }
        if s.control == "observing" { return "只旁观：输入权已释放" }
        if s.control == "external" { return "输入权在桌面终端（由其他端驱动）" }
        return nil
    }

    /// 释放过的会话可以在手机上直接接管回来（external 是别的端在驱动，和 web 一样不提供抢夺）
    private var controlAction: (label: String, action: () -> Void)? {
        guard let s = state, s.control == "observing", s.operability != "read-only" else { return nil }
        return ("接管输入", { Task { await store.setControl("take") } })
    }

    @ViewBuilder
    private var topStrips: some View {
        if let s = state, !s.plan.isEmpty || s.stale || store.error != nil {
            VStack(alignment: .leading, spacing: 0) {
                PlanStrip(plan: s.plan)
                if s.stale { StaleBanner(errorCode: s.errorCode) }
                ErrorBanner(message: store.error)
            }
            .padding(.vertical, 4)
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: OWRadius.l, style: .continuous))
            .padding(.horizontal, 8)
        } else if let err = store.error {
            ErrorBanner(message: err)
        }
    }

    private func send() async {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = pendingImages
        guard !text.isEmpty || !images.isEmpty else { return }
        if await store.send(text: text, images: images.map(\.payload)) {
            input = ""; pendingImages = []
        }
    }
}

private struct InfoSheet: View {
    let state: AgentState
    let setControl: (String) -> Void

    var body: some View {
        let s = state
        VStack(alignment: .leading, spacing: 0) {
            InfoRow(label: "引擎", value: s.backend + (s.model.map { " · \($0)" } ?? ""))
            InfoRow(label: "控制权", value: s.control == "ownward" ? "ownward（可输入）" : (s.control == "external" ? "桌面终端" : "旁观（已释放输入权）"))
            if let t = s.tokens {
                let total = t.total ?? ((t.input ?? 0) + (t.output ?? 0))
                InfoRow(label: "token", value: String(format: "%.1fk", Double(total) / 1000))
            }
            if let c = s.ctxTokens { InfoRow(label: "上下文", value: String(format: "%.1fk", Double(c) / 1000)) }
            InfoRow(label: "最近活动", value: TimeFormat.ago(epochMs: s.lastActivityAt))
            // 接管租约切换（web detailHead 同款）：ownward → 可释放给桌面终端；observing → 接管回手机
            if s.operability != "read-only" {
                HStack(spacing: 8) {
                    if s.control == "ownward" {
                        Button("释放输入权") { Haptics.tap(); setControl("release") }.buttonStyle(.bordered)
                    } else if s.control == "observing" {
                        Button("接管输入") { Haptics.action(); setControl("take") }.buttonStyle(.borderedProminent)
                    }
                }
                .font(.owLabel)
                .padding(.top, 8)
            }
            // 释放后在别的终端续聊的命令（服务端按 nativeRef 拼好），复制到剪贴板方便发给 Mac
            if let cmd = s.resume?.cmd, !cmd.isEmpty, s.control == "observing" {
                Text("在其他终端继续：").font(.owLabelS).foregroundStyle(OW.textDim)
                    .padding(.top, 12).padding(.bottom, 4)
                HStack(spacing: 8) {
                    Text(cmd).font(.owMonoS).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                    Button("复制") { UIPasteboard.general.string = cmd; Haptics.selection() }.font(.owLabel)
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(OW.surface2, in: RoundedRectangle(cornerRadius: OWRadius.s))
            }
            Spacer()
        }
        .padding(.horizontal, 24).padding(.top, 28)
        .presentationBackground(OW.bg)
    }
}
