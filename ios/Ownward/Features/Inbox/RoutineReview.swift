// 例行草稿审阅（对齐 android ui/InboxScreen.kt 的 RoutineRow + 审稿弹窗）。
// 纯规则单独成函数（与 android RoutineReviewTest 逐条配对）：哪些状态可编辑/可提交、
// 每张卡给哪些动作、「保存并写入」保存失败绝不触发写入。
import SwiftUI

func routineCanEdit(_ status: String) -> Bool { status == "draft" }

func routineCanSubmit(_ status: String, loadedSuccessfully: Bool) -> Bool {
    loadedSuccessfully && routineCanEdit(status)
}

func routineActions(_ r: RoutineCard) -> Set<String> {
    var out = Set<String>()
    if r.status == "pending" { out.insert("generate") }
    if r.hasDraft { out.insert("view") }
    if r.status == "draft" { out.insert("skip") }
    if r.status == "writing", let t = r.taskId, !t.isEmpty { out.insert("task") }
    if let u = r.docUrl, !u.isEmpty { out.insert("document") }
    return out
}

func saveThenWrite(save: () async throws -> Void, write: () async throws -> Void) async throws {
    try await save()
    try await write()
}

/// 草稿审阅页：全屏 sheet，正文编辑区撑满剩余高度。键盘弹起时 SwiftUI 的安全区自动收缩，
/// 编辑区跟着缩到键盘上方（android 端是全屏 Dialog + safeDrawingPadding，同一口径）。
struct RoutineDraftSheet: View {
    let routine: RoutineCard
    let client: OwnwardClient
    let onChanged: () -> Void
    var autoFocus = false   // DEBUG 直达用：载入后直接聚焦编辑区，把键盘叫出来看避让
    @Environment(\.dismiss) private var dismiss
    @FocusState private var editing: Bool

    @State private var content = ""
    @State private var loading = true
    @State private var loadedSuccessfully = false
    @State private var loadError: String?
    @State private var status: String
    @State private var stale: Bool
    @State private var submitting = false
    @State private var error: String?

    init(routine: RoutineCard, client: OwnwardClient, onChanged: @escaping () -> Void, autoFocus: Bool = false) {
        self.routine = routine; self.client = client; self.onChanged = onChanged; self.autoFocus = autoFocus
        _status = State(initialValue: routine.status)
        _stale = State(initialValue: routine.stale)
    }

    private var canEdit: Bool { routineCanEdit(status) }
    private var canSubmit: Bool { !loading && routineCanSubmit(status, loadedSuccessfully: loadedSuccessfully) }

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if !loadedSuccessfully {
                    VStack(spacing: 12) {
                        Text(loadError ?? "草稿未加载").font(.owBodyS).foregroundStyle(OW.danger)
                        Button("重试") { Haptics.tap(); Task { await load() } }.font(.owLabel)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        if stale {
                            Text("素材已更新，这份草稿可能过期，请重新核对。").font(.owBodyS).foregroundStyle(OW.warn)
                        }
                        Text(canEdit ? "草稿正文" : "正文（只读）").font(.owLabelS).foregroundStyle(OW.textDim)
                        editor
                        ErrorBanner(message: error)
                    }
                    .padding(16)
                }
            }
            .background(OW.bg)
            .navigationTitle(routine.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("关闭") { dismiss() }.disabled(submitting) }
                if canSubmit {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("保存") { Haptics.tap(); submit(close: false) { try await save() } }.disabled(submitting)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("保存并写入") {
                            Haptics.action()
                            submit(close: true) {
                                try await saveThenWrite(
                                    save: { try await save() },
                                    write: { try await client.routineWrite(id: routine.id, date: routine.date).requireOk("写入失败") }
                                )
                            }
                        }
                        .disabled(submitting)
                    }
                }
            }
            .task { await load() }
        }
        .interactiveDismissDisabled(submitting)
    }

    @ViewBuilder private var editor: some View {
        if canEdit {
            TextEditor(text: $content)
                .font(.owBody)
                .scrollContentBackground(.hidden)
                .scrollDismissesKeyboard(.interactively)
                .padding(6)
                .background(OW.surface1, in: RoundedRectangle(cornerRadius: OWRadius.m))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .focused($editing)
                .disabled(submitting)
        } else {
            // 只读不用 TextEditor：disabled 的编辑器连滚都滚不动
            ScrollView {
                Text(content).font(.owBody).foregroundStyle(OW.text).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(10)
            }
            .background(OW.surface1, in: RoundedRectangle(cornerRadius: OWRadius.m))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func load() async {
        loading = true
        loadedSuccessfully = false
        loadError = nil
        do {
            let d = try await client.routineDraft(id: routine.id, date: routine.date)
            content = d.draft
            status = d.status
            stale = d.stale
            loadedSuccessfully = true
            if autoFocus, routineCanEdit(d.status) { editing = true }
        } catch {
            loadError = error.userMessage
        }
        loading = false
    }

    private func save() async throws {
        try await client.routineSaveDraft(id: routine.id, date: routine.date, content: content).requireOk("保存失败")
        stale = false
    }

    private func submit(close: Bool, _ op: @escaping () async throws -> Void) {
        guard !submitting else { return }
        submitting = true
        error = nil
        Task {
            do {
                try await op()
                if close { dismiss() }
                onChanged()
            } catch {
                Haptics.error()
                self.error = error.userMessage
            }
            submitting = false
        }
    }
}
