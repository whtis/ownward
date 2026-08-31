// 派新任务（web「派任务」弹窗的手机版，对齐 android ui/DispatchScreen.kt）。
// 固定 bg=true：手机上没有 terminal 通道（terminal 模式会在 daemon 那台机器上弹终端）。
// 默认值由服务端下发（state.dispatchDefaults），候选目录来自 /api/projects，
// 型号表复用 /api/chat/providers（同一台机器能用的模型是同一批，不另维护）。
// 派发成功直接进会话（onDispatched），不停在表单。
import SwiftUI
import PhotosUI

/// /api/work 只认这三个引擎（src/verticals.ts 白名单）；chat 的 codex-alt 之类第二账号键派任务不可用
let workEngines: [(key: String, label: String)] = [
    ("claude", "Claude"), ("codex", "Codex"), ("codebuddy", "CodeBuddy"),
]

/// 服务端 chat.providers 没配该引擎时的兜底型号表（与 web/app.js 同一份）
private let fallbackModels: [String: [String]] = [
    "claude": ["fable", "opus", "sonnet", "haiku"],
    "codex": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
    "codebuddy": ["hy3", "glm-5.2", "kimi-k3-1", "minimax-m3", "deepseek-v4-pro", "deepseek-v3-2-volc"],
]

private let workProviderEffortsByProvider: [String: [String]] = [
    "claude": ["low", "medium", "high", "xhigh", "max"],
    "codebuddy": ["low", "medium", "high", "xhigh", "max"],
]

let workCodexModelEfforts: [String: [String]] = [
    "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
    "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
    "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
    "gpt-5.5": ["low", "medium", "high", "xhigh"],
    "gpt-5.4": ["low", "medium", "high", "xhigh"],
]

func workProviderDefaultModel(_ provider: String) -> String {
    provider == "codex" ? "gpt-5.6-sol" : ""
}

func workProviderHandoffModel(_ provider: String) -> String {
    switch provider {
    case "codex": "gpt-5.6-sol"
    case "codebuddy": "hy3"
    default: "sonnet"
    }
}

func workProviderModels(_ provider: String, providers: [String: [String]]) -> [String] {
    let models = provider == "codex" ? (fallbackModels[provider] ?? []) : (providers[provider] ?? []) + (fallbackModels[provider] ?? [])
    return models.reduce(into: []) { result, model in
        if !result.contains(model) { result.append(model) }
    }
}

func workProviderEfforts(_ provider: String, model: String) -> [String] {
    provider == "codex"
        ? (workCodexModelEfforts[model.isEmpty ? workProviderDefaultModel(provider) : model] ?? [])
        : (workProviderEffortsByProvider[provider] ?? [])
}

func workProviderDefaultEffort(_ provider: String, model: String) -> String {
    let efforts = workProviderEfforts(provider, model: model)
    return efforts.contains("medium") ? "medium" : (efforts.first ?? "")
}

func workProviderSelectionIsValid(
    _ provider: String, model: String, effort: String, allowOmitted: Bool = false
) -> Bool {
    if !allowOmitted && (model.isEmpty || effort.isEmpty) { return false }
    let effectiveModel = model.isEmpty ? workProviderDefaultModel(provider) : model
    let modelValid = model.isEmpty || provider != "codex" || workCodexModelEfforts[effectiveModel] != nil
    let effortValid = effort.isEmpty || workProviderEfforts(provider, model: effectiveModel).contains(effort)
    return modelValid && effortValid
}

func normalizedDispatchDefaultEffort(_ provider: String, model: String, configured: String?) -> String {
    guard let configured, !configured.isEmpty else { return "" }
    return workProviderEfforts(provider, model: model).contains(configured)
        ? configured : workProviderDefaultEffort(provider, model: model)
}

/// 描述留空时的开场白（与 web 同款）：开一个「待命会话」，进会话再说要干啥
private let standbyPrompt = "你是常驻结对助手。本条只是开场，简短确认待命即可，等我下一条消息再开始干活。"

struct DispatchView: View {
    let client: OwnwardClient
    let onDispatched: (String) -> Void

    @State private var projects: [ProjectDir] = []
    @State private var providers: [String: [String]] = [:]
    @State private var allowFullAccess = false
    @State private var dir = ""
    @State private var task = ""
    @State private var provider = "claude"
    @State private var model = ""            // "" = 引擎默认
    @State private var effort = ""           // "" = Provider 默认
    @State private var permission = "safe"   // safe | bypass
    @State private var worktree = true
    @State private var defaultsApplied = false
    @State private var browsing = false
    @State private var pendingImages: [PendingImage] = []
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var submitting = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    private var models: [String] {
        workProviderModels(provider, providers: providers)
    }

    var body: some View {
        Form {
            if let error {
                Section { Text(error).font(.owBodyS).foregroundStyle(OW.danger) }
            }
            Section("项目目录") {
                TextField("~/workspace/项目", text: $dir)
                    .font(.owBody).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("浏览远程目录") { Haptics.tap(); browsing = true }
                    .font(.owLabel)
                if !projects.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(projects) { p in
                                let on = dir.trimmingCharacters(in: .whitespaces) == p.dir
                                Button {
                                    Haptics.selection(); dir = p.dir
                                } label: {
                                    Text(p.name.isEmpty ? p.dir : p.name)
                                        .font(.owLabel).foregroundStyle(on ? OW.bg : OW.text)
                                        .padding(.horizontal, 12).padding(.vertical, 6)
                                        .background(on ? OW.text : OW.surface2, in: Capsule())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
            Section("引擎") {
                // 型号表随引擎切换，旧值不跨引擎。清空写在 Binding 的 setter 里而不是 .onChange：
                // 后者对「服务端默认值把 provider 也一起改了」同样会触发，顺序上会把刚填好的默认 model 抹掉
                Picker("引擎", selection: Binding(
                    get: { provider },
                    set: { new in
                        if new != provider {
                            provider = new
                            model = workProviderDefaultModel(new)
                            effort = workProviderDefaultEffort(new, model: model)
                        }
                    }
                )) {
                    ForEach(workEngines, id: \.key) { Text($0.label).tag($0.key) }
                }
                .pickerStyle(.segmented)
                Picker("模型", selection: Binding(
                    get: { model },
                    set: { next in
                        model = next
                        let allowed = workProviderEfforts(provider, model: next)
                        if !allowed.contains(effort) { effort = workProviderDefaultEffort(provider, model: next) }
                    }
                )) {
                    Text("默认").tag("")
                    // 服务端默认值可能给了个不在型号表里的型号（配置比 providers 新）——
                    // 不把它补进选项，Picker 会显示空白，看起来像没选
                    if !model.isEmpty, !models.contains(model) { Text(model).tag(model) }
                    ForEach(models, id: \.self) { Text($0).tag($0) }
                }
                Picker("思考深度", selection: $effort) {
                    Text("默认").tag("")
                    ForEach(workProviderEfforts(provider, model: model), id: \.self) { Text($0).tag($0) }
                }
            }
            Section {
                Picker("权限", selection: $permission) {
                    Text("高危命令审批").tag("safe")
                    Text("全放行").tag("bypass")
                }
                .pickerStyle(.segmented)
                // 分段控件没法只禁掉其中一段，所以选中就弹回来 + footer 说明原因。
                // 光靠服务端拒（dispatch.ts 会 throw SESSION_ACCESS_NOT_GRANTED）也行，但那是填完表才报错
                .onChange(of: permission) {
                    if permission == "bypass", !allowFullAccess {
                        permission = "safe"
                        error = "服务端未开启 architecture.allowFullAccess，全放行不可选"
                        Haptics.warning()
                    }
                }
                Toggle(isOn: $worktree) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("隔离 worktree").listBody()
                        Text("在独立分支/目录里干活，不碰主检出").caption()
                    }
                }
            } header: {
                Text("权限")
            } footer: {
                if !allowFullAccess {
                    Text("服务端未开启 architecture.allowFullAccess，全放行不可选").font(.owBodyS)
                }
            }
            Section("任务描述") {
                TextField("要做什么？留空=先开一个待命会话，进会话再说", text: $task, axis: .vertical)
                    .font(.owBody).lineLimit(4...12)
                imageRow
            }
            Section {
                Button {
                    Task { await submit() }
                } label: {
                    HStack {
                        Spacer()
                        if submitting { ProgressView().controlSize(.small) }
                        else { Text(task.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "开待命会话" : "派发任务") }
                        Spacer()
                    }
                }
                .disabled(submitting || dir.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .scrollContentBackground(.hidden)
        .background(OW.bg)
        .navigationTitle("新任务")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .task { await load() }
        .sheet(isPresented: $browsing) {
            DirectoryPicker(client: client, startPath: dir.trimmingCharacters(in: .whitespaces).isEmpty ? nil : dir.trimmingCharacters(in: .whitespaces)) { picked in
                dir = picked
                browsing = false
            }
        }
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            Task {
                let (imgs, failed) = await PendingImage.load(items)
                pendingImages = Array((pendingImages + imgs).prefix(ImageEncoder.maxImages))
                if failed > 0 { error = "部分图片读取失败或超过 5MB" }
                pickerItems = []
            }
        }
    }

    private var imageRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(pendingImages) { img in
                    Image(uiImage: img.thumbnail).resizable().scaledToFill()
                        .frame(width: 64, height: 64)
                        .clipShape(RoundedRectangle(cornerRadius: OWRadius.m))
                        .overlay(alignment: .topTrailing) {
                            Button {
                                Haptics.selection()
                                withAnimation(.snappy) { pendingImages.removeAll { $0.id == img.id } }
                            } label: {
                                Image(systemName: "xmark.circle.fill").font(.system(size: 18))
                                    .symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.6))
                            }
                            .buttonStyle(.plain).offset(x: 5, y: -5)
                            .accessibilityLabel("移除图片")
                        }
                }
                if pendingImages.count < ImageEncoder.maxImages {
                    PhotosPicker(selection: $pickerItems, maxSelectionCount: ImageEncoder.maxImages, matching: .images) {
                        Image(systemName: "plus").font(.system(size: 20)).foregroundStyle(OW.textDim)
                            .frame(width: 64, height: 64)
                            .background(OW.surface2, in: RoundedRectangle(cornerRadius: OWRadius.m))
                    }
                    .accessibilityLabel("附图")
                }
                Text(pendingImages.isEmpty ? "附图（可选）" : "\(pendingImages.count) 张").caption()
            }
            .padding(.vertical, 4)
        }
    }

    private func load() async {
        if let p = try? await client.projects() { projects = p }
        if let p = try? await client.chatProviders() { providers = p }
        do {
            let s = try await client.state()
            allowFullAccess = s.allowFullAccess
            let d = s.dispatchDefaults
            if !defaultsApplied {
                if dir.isEmpty, let dd = d.dir, !dd.isEmpty { dir = dd }
                if let p = d.provider, workEngines.contains(where: { $0.key == p }) { provider = p }
                else if let codex = d.codex { provider = codex ? "codex" : "claude" }
                model = d.model.flatMap { $0.isEmpty ? nil : $0 } ?? workProviderDefaultModel(provider)
                effort = normalizedDispatchDefaultEffort(provider, model: model, configured: d.effort)
                if d.permission == "safe" || (d.permission == "bypass" && s.allowFullAccess) { permission = d.permission ?? "safe" }
                defaultsApplied = true
            }
            // 服务端没开全权限时 bypass 不可选（与 web 的双门一致）
            if permission == "bypass", !s.allowFullAccess { permission = "safe" }
        } catch {
            self.error = error.userMessage
        }
    }

    private func submit() async {
        let d = dir.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !d.isEmpty else { error = "先选项目目录"; return }
        guard effort.isEmpty || workProviderEfforts(provider, model: model).contains(effort) else {
            error = "所选模型不支持这个思考深度"; return
        }
        guard !submitting else { return }
        submitting = true; error = nil
        defer { submitting = false }
        let body = task.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let r = try await client.dispatchWork(
                dir: d,
                task: body.isEmpty ? standbyPrompt : body,
                provider: provider, worktree: worktree,
                model: model.isEmpty ? nil : model,
                effort: effort.isEmpty ? nil : effort,
                permission: permission,
                images: pendingImages.map(\.payload)
            )
            guard r.ok else { error = r.msg.isEmpty ? "派发失败" : r.msg; Haptics.error(); return }
            if let id = r.taskId { Haptics.success(); onDispatched(id) } else { dismiss() }
        } catch {
            self.error = error.userMessage; Haptics.error()
        }
    }
}


/// 目录选择器的导航状态（android DispatchScreen.DirPickerNav 同款，纯逻辑可单测）：
/// 手输的起点路径载入失败时，第一次自动退回授权根视图；之后的失败如实报错。
struct DirPickerNav: Equatable {
    var requestedPath: String?
    var canFallbackToRoots = true

    func loaded() -> DirPickerNav { DirPickerNav(requestedPath: requestedPath, canFallbackToRoots: false) }
    func failed() -> DirPickerNav? {
        canFallbackToRoots && requestedPath != nil ? DirPickerNav(requestedPath: nil, canFallbackToRoots: false) : nil
    }
    func go(_ path: String?) -> DirPickerNav { DirPickerNav(requestedPath: path, canFallbackToRoots: false) }
}

/// 与网页/android 目录选择器共用 /api/fs/dirs：根视图（path=null）不能选，进入授权根后可选当前目录。
private struct DirectoryPicker: View {
    let client: OwnwardClient
    let startPath: String?
    let onPick: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var listing: FsDirListing?
    @State private var loading = true
    @State private var error: String?
    @State private var nav: DirPickerNav

    init(client: OwnwardClient, startPath: String?, onPick: @escaping (String) -> Void) {
        self.client = client; self.startPath = startPath; self.onPick = onPick
        _nav = State(initialValue: DirPickerNav(requestedPath: startPath))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if loading {
                        HStack { Spacer(); ProgressView(); Spacer() }.padding(.vertical, 24)
                    } else if let error {
                        Text(error).font(.owBodyS).foregroundStyle(OW.danger)
                    } else {
                        let entries = listing?.entries ?? []
                        if entries.isEmpty {
                            Text("没有子目录，可选择当前目录").font(.owBodyS).foregroundStyle(OW.textDim)
                        }
                        ForEach(entries) { entry in
                            HStack(spacing: 8) {
                                Text("📁")
                                Text(entry.name).font(.owBody).foregroundStyle(OW.text).lineLimit(1)
                                if entry.git { Text("git").font(.owLabelS).foregroundStyle(OW.accent) }
                                Spacer(minLength: 8)
                                Button("选择") { Haptics.selection(); onPick(entry.path) }
                                    .font(.owLabel).buttonStyle(.borderless)
                            }
                            .contentShape(Rectangle())
                            .onTapGesture { Haptics.tap(); nav = nav.go(entry.path) }
                        }
                        if listing?.truncated == true {
                            Text("目录太多，只显示前 300 个；可继续下钻或手输路径")
                                .font(.owLabelS).foregroundStyle(OW.danger)
                        }
                    }
                } header: {
                    Text(listing?.path ?? "授权根目录").textCase(nil).lineLimit(2)
                }
            }
            .navigationTitle("选择项目目录")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("选择此目录") {
                        Haptics.selection()
                        if let p = listing?.path { onPick(p) }
                    }
                    .disabled(loading || error != nil || listing?.path == nil)
                }
                ToolbarItem(placement: .bottomBar) {
                    // 根视图（path=null）没有上级；授权根的 parent 为 null → 回根视图
                    Button("返回上级") { Haptics.tap(); nav = nav.go(listing?.parent) }
                        .disabled(loading || error != nil || listing?.path == nil)
                }
            }
            .task(id: nav.requestedPath) { await load() }
        }
        .presentationDetents([.medium, .large])
    }

    private func load() async {
        loading = true
        error = nil
        do {
            listing = try await client.fsDirs(path: nav.requestedPath)
            nav = nav.loaded()
        } catch {
            // 手输值可能含 ~ 或已失效：首次打开与网页一致，自动退回授权根视图
            if let retry = nav.failed() { nav = retry; return }
            self.error = error.userMessage
        }
        loading = false
    }
}
