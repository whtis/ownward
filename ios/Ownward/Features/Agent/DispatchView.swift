// 派新任务（web「派任务」弹窗的手机版，对齐 android ui/DispatchScreen.kt）。
// 固定 bg=true：手机上没有 terminal 通道（terminal 模式会在 daemon 那台机器上弹终端）。
// 默认值由服务端下发（state.dispatchDefaults），候选目录来自 /api/projects，
// 型号表复用 /api/chat/providers（同一台机器能用的模型是同一批，不另维护）。
// 派发成功直接进会话（onDispatched），不停在表单。
//
// 谁来接（src/role-auto.ts）：缺省「自动」——按目录匹配这个仓库的项目 Owner，没有就在派发时建；
// 主目录不是仓库时按任务描述匹配领域角色，拿不准就摆出候选让人手选（选好之前不许提交）；
// 匹配上的点名发过去——派出去的就是预览给人看的那个（roleSubmit）。
// 也可以点名一个角色（它登记的工作目录直接填好）或不用角色。跨了几个项目又没有角色同时管时，
// 问一句要不要建跨项目角色。规则在 UI/Roles.swift（与 web / android 同一张预期表）。
import SwiftUI
import PhotosUI

/// /api/work 只认这三个引擎（src/verticals.ts 白名单）；chat 的 codex-alt 之类第二账号键派任务不可用
let workEngines: [(key: String, label: String)] = [
    ("claude", "Claude"), ("codex", "Codex"), ("codebuddy", "CodeBuddy"),
]

/// 服务端 chat.providers 没配该引擎时的兜底型号表（与 web/app.js 同一份）
private let fallbackModels: [String: [String]] = [
    "claude": ["fable", "opus", "sonnet", "haiku"],
    "codex": ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex-spark"],
    "codebuddy": ["hy3", "hy3-x", "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5v-turbo", "minimax-m3-pay", "minimax-m2.7", "kimi-k3-2", "kimi-k2.7", "kimi-k2.6", "deepseek-v4-pro", "deepseek-v4-flash"],
]

private let workProviderEffortsByProvider: [String: [String]] = [
    "claude": ["low", "medium", "high", "xhigh", "max"],
    "codebuddy": ["minimal", "low", "medium", "high", "xhigh", "max"],   // codebuddy --help 比 claude 多一档 minimal
]

let workCodexModelEfforts: [String: [String]] = [
    "gpt-6-astra": ["low", "medium", "high", "xhigh", "max", "ultra"],
    "gpt-5.6-sol": ["low", "medium", "high", "xhigh", "max", "ultra"],
    "gpt-5.6-terra": ["low", "medium", "high", "xhigh", "max", "ultra"],
    "gpt-5.6-luna": ["low", "medium", "high", "xhigh", "max"],
    "gpt-5.5": ["low", "medium", "high", "xhigh"],
    "gpt-5.3-codex-spark": ["low", "medium", "high", "xhigh"],
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

/// 目录选择器开给谁：主目录还是附加目录（同一个 .sheet——一个视图上挂两个 sheet 在 iOS 上会互相顶掉）
private enum BrowseTarget: String, Identifiable {
    case main, extra
    var id: String { rawValue }
}

struct DispatchView: View {
    let client: OwnwardClient
    /// 角色页「派任务给它」点名进来的角色 id（目录按角色登记的填好）
    var initialRole: String? = nil
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
    @State private var browsing: BrowseTarget?
    // 谁来接
    @State private var roles: [AgentRole] = []
    @State private var rolesSupported = false        // 服务端声明 /api/work 收 role 键才画这一节
    @State private var roleChoice = roleAuto
    @State private var initialRoleApplied = false
    @State private var extraDirs: [String] = []
    @State private var preview: RolePreview?
    @State private var previewError: String?
    @State private var byTask = false                // 上一份预览是按任务描述匹配的（by=task）：只有这时改描述才重新预览
    @State private var previewedDirs: String?        // 眼下这份预览/错误是哪组目录问的（nil = 刚清掉，新的还没到）
    @State private var previewedTask: String?        // ……发请求那一刻带的是哪段任务描述（nil = 同上）
    @State private var previewNudge = 0              // 提交被「正在匹配」拦下：换个 id 马上重问一次
    @State private var previewNow = false            // ……那一轮不等防抖
    @State private var crossSkipped: Set<String> = []
    @State private var creatingCross = false
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
                Button("浏览远程目录") { Haptics.tap(); browsing = .main }
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
            Section {
                // 附加目录：agent 能同时读写这几个仓库；跨项目时下面「角色」一节会问要不要建跨项目角色
                ForEach(extraDirs, id: \.self) { x in
                    HStack {
                        Text((x as NSString).lastPathComponent).font(.owBody).lineLimit(1)
                        Spacer(minLength: 8)
                        Button {
                            Haptics.selection(); extraDirs.removeAll { $0 == x }
                        } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(OW.textDim) }
                        .buttonStyle(.borderless).accessibilityLabel("移除附加目录")
                    }
                }
                Button("添加附加目录") { Haptics.tap(); browsing = .extra }.font(.owLabel)
            } header: {
                Text("附加目录")
            }
            if rolesSupported { roleSection }
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
        // 「自动」会落到谁、是不是跨项目：目录一变就重新问；上一份是按任务描述匹配的，描述变了也重新问
        // （task(id:) 换 id 会取消上一次，天然防抖）
        .task(id: previewKey) { await refreshPreview() }
        .sheet(item: $browsing) { target in
            DirectoryPicker(client: client, startPath: dir.trimmingCharacters(in: .whitespaces).isEmpty ? nil : dir.trimmingCharacters(in: .whitespaces)) { picked in
                switch target {
                case .main: dir = picked
                case .extra:
                    if picked == dir.trimmingCharacters(in: .whitespaces) { error = "附加目录不能和主目录相同" }
                    else if !extraDirs.contains(picked) { extraDirs.append(picked) }
                }
                browsing = nil
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

    /// 谁来接：选择器 + 一句「会带上谁的记忆」+ 跨项目时问要不要建跨项目角色
    @ViewBuilder private var roleSection: some View {
        let groups = dispatchableRoles(roles)
        let hint = roleHint(roleChoice, preview: preview, roles: roles,
                            dirBlank: dir.trimmingCharacters(in: .whitespaces).isEmpty)
        let candidates = rolePickCandidates(roleChoice, preview: preview)
        Section {
            Picker("谁来接", selection: Binding(get: { roleChoice }, set: { pickRole($0) })) {
                Text("自动匹配（推荐）").tag(roleAuto)
                ForEach(groups.projects) { r in Text(r.name.isEmpty ? r.id : r.name).tag(r.id) }
                if !groups.domains.isEmpty {
                    Section("领域角色") {
                        ForEach(groups.domains) { r in Text(r.name.isEmpty ? r.id : r.name).tag(r.id) }
                    }
                }
                ForEach(groups.cross) { r in Text(r.name.isEmpty ? r.id : r.name).tag(r.id) }
                Text("不用角色").tag(roleNone)
            }
            Text(previewError ?? hint.text)
                .font(.owBodyS)
                .foregroundStyle(previewError != nil || hint.tone == .warn ? OW.danger : hint.tone == .new ? OW.accent : OW.textDim)
            if !candidates.isEmpty {
                // 拿不准由哪个领域角色接：候选直接摆出来点，外加「不用角色」
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(candidates + [RoleRefLite(id: roleNone, name: "不用角色")]) { p in
                            Button {
                                pickRole(p.id)
                            } label: {
                                Text(p.name.isEmpty ? p.id : p.name)
                                    .font(.owLabel).foregroundStyle(OW.text)
                                    .padding(.horizontal, 12).padding(.vertical, 6)
                                    .background(OW.surface2, in: Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
            if let cross = crossPrompt(roleChoice, preview: preview, skipped: crossSkipped) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(crossPromptText(cross)).font(.owBodyS).foregroundStyle(OW.text)
                    if cross.possible {
                        HStack(spacing: 12) {
                            Button {
                                Task { await createCross(cross) }
                            } label: { Text("建「\(cross.name)」并由它接手") }
                            .buttonStyle(.borderedProminent).disabled(creatingCross)
                            Button("不用") { Haptics.selection(); crossSkipped.insert(crossKey(cross)) }
                                .buttonStyle(.borderless)
                        }
                    }
                }
                .padding(.vertical, 4)
            }
        } header: {
            Text("角色")
        }
    }

    /// 预览按哪组目录问：一变就重新问（400ms 防抖）
    private var previewDirs: String {
        "\(rolesSupported)|\(dir.trimmingCharacters(in: .whitespaces))|\(extraDirs.joined(separator: "\n"))"
    }

    /// 输入框当前的任务描述（同派发时一样去掉首尾空白）：预览带它，提交时拿它比对预览是不是按它问的
    private var currentTask: String { task.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// 任务描述只在上一份预览是按描述匹配的（by=task）时才算进来：别的时候描述怎么改都不影响结果，
    /// 也别每敲一个字都让服务端调一次模型
    private var previewKey: String {
        "\(previewNudge)|" + (byTask ? previewDirs + "\n\n" + currentTask : previewDirs)
    }

    private func refreshPreview() async {
        guard !Task.isCancelled else { return }   // 还没开跑就被新一轮顶掉：别动任何状态（尤其别把 previewNow 吃掉）
        let now = previewNow; previewNow = false
        let dirs = previewDirs
        let sameDirs = dirs == previewedDirs
        // 目录没变、要问的也没变：只是 byTask 跟着刚到的那份预览翻了（翻成 false 描述就无关了；
        // 翻成 true 时那份正是按眼下这段描述问的）——眼下显示的就是对的，别清掉再问一遍。提交时点名要重问的除外
        if !now, sameDirs, !byTask || currentTask == previewedTask { return }
        preview = nil; previewError = nil; previewedTask = nil
        if !sameDirs { previewedDirs = nil; byTask = false }   // 目录变了：先当不是按描述匹配的，等新一份预览再定
        let d = dir.trimmingCharacters(in: .whitespacesAndNewlines)
        guard rolesSupported, !d.isEmpty else { return }
        var text = currentTask
        do {
            // 手输目录时别每敲一个字都问一次；只改了描述的等更久——按描述匹配服务端要调一次模型
            if !now { try await Task.sleep(for: .milliseconds(sameDirs ? 800 : 400)) }
            text = currentTask   // 只改目录的那轮，防抖期间改描述不会重来：按最新的描述问（记下的就是这一段）
            let p = try await client.resolveRoles(dir: d, extraDirs: extraDirs.filter { $0 != d }, task: text)
            guard !Task.isCancelled else { return }   // 目录或描述在这期间又变了：这份是旧的预览，新一轮会自己问
            preview = p
            previewedDirs = dirs; previewedTask = text
            byTask = previewByTask(p)
        } catch {
            // 被新一轮 .task(id:) 顶掉：sleep 抛 CancellationError，URLSession 抛的却是 URLError(.cancelled)，
            // 统一看 Task.isCancelled——别把「已取消」写进提示（新一轮已经清过 previewError）
            guard !Task.isCancelled else { return }
            previewError = error.userMessage
            previewedDirs = dirs; previewedTask = text
        }
    }

    /// 点名一个角色：它登记了工作目录就替人填好（第一个当主目录，其余当附加目录）——派给角色，不用再找目录。
    /// 领域角色不绑目录（它登记的一般就是 ~/workspace）：主目录已经填了就不动，空着才按它登记的填
    private func pickRole(_ choice: String) {
        Haptics.selection()
        roleChoice = choice
        guard let r = roles.first(where: { $0.id == choice }), let d = roleDirs(r) else { return }
        if r.origin == "domain", !dir.trimmingCharacters(in: .whitespaces).isEmpty { return }
        dir = d.dir; extraDirs = d.extras
    }

    private func createCross(_ cross: RoleCross) async {
        guard !creatingCross else { return }
        creatingCross = true
        defer { creatingCross = false }
        do {
            let r = try await client.createCrossRole(dirs: cross.dirs)
            guard r.ok, let role = r.role else { error = r.msg.isEmpty ? "没建成" : r.msg; Haptics.error(); return }
            if let fresh = try? await client.roles() { roles = fresh.roles }
            roleChoice = role.id
            Haptics.success()
        } catch {
            self.error = error.userMessage; Haptics.error()
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
        // 角色放在默认值之后：点名的角色带着自己的工作目录，要盖过 dispatch.defaults.dir
        if let r = try? await client.roles() {
            roles = r.roles
            rolesSupported = r.ok && r.dispatchRole
            if !rolesSupported { roleChoice = roleAuto }
            if rolesSupported, let want = initialRole, !initialRoleApplied {
                if let role = r.roles.first(where: { $0.id == want }) {
                    roleChoice = want
                    if let d = roleDirs(role) { dir = d.dir; extraDirs = d.extras }
                } else {
                    roleChoice = roleAuto
                    error = "这个角色读不到了（可能刚被归档）"
                }
                initialRoleApplied = true
            }
        }
    }

    private func submit() async {
        let d = dir.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !d.isEmpty else { error = "先选项目目录"; return }
        guard effort.isEmpty || workProviderEfforts(provider, model: model).contains(effort) else {
            error = "所选模型不支持这个思考深度"; return
        }
        // 派出去的角色 = 预览给人看的角色：按描述匹配上的点名发；描述改了新预览还没回来、或拿不准还选着「自动」就先不派
        let role: String?
        switch roleSubmit(choice: roleChoice, preview: preview, byTask: byTask, previewTask: previewedTask ?? "",
                          currentTask: currentTask, supported: rolesSupported) {
        case .send(let r): role = r
        case .block(let msg):
            error = msg; Haptics.warning()
            if msg == roleMatchingMsg { previewNow = true; previewNudge += 1 }   // 不等防抖，马上按眼下的描述重问
            return
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
                images: pendingImages.map(\.payload),
                role: role,
                extraDirs: extraDirs.filter { $0 != d }
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
