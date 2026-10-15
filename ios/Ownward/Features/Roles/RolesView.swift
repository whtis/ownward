// 角色（web 角色页的手机版，只做「找到角色 → 派任务给它」这一件事；对齐 android ui/RolesScreen.kt）。
// 项目 Owner 是往仓库派任务时自动建的，跨项目角色由人点头才建（顶上的建议），领域角色管没有仓库的那类活；
// 原则 / 决策 / 候选晋升这些长期记忆的维护还在 web 角色页——手机上不做人工审批门。
import SwiftUI

struct RolesView: View {
    let client: OwnwardClient
    let openDispatch: (String) -> Void

    @State private var roles: [AgentRole] = []
    @State private var suggestions: [RoleSuggestion] = []
    @State private var supported = true
    @State private var loaded = false
    @State private var busyKey: String?
    @State private var error: String?

    var body: some View {
        let groups = groupRoles(roles)
        List {
            if let error {
                Section { Text(error).font(.owBodyS).foregroundStyle(OW.danger) }
            }
            if loaded, !supported {
                Section { Text("这台 daemon 还没有自动角色：升级 Ownward 后，这里会列出各项目的 Owner").caption() }
            }
            if !suggestions.isEmpty {
                Section("发现跨项目的工作") {
                    ForEach(suggestions) { s in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(s.labels.joined(separator: " + ")).font(.owTitleS).foregroundStyle(OW.text)
                            Text(suggestionSub(s)).caption()
                            HStack(spacing: 12) {
                                Button("建「\(s.name)」") { Task { await accept(s) } }
                                    .buttonStyle(.borderedProminent)
                                Button("忽略") { Task { await dismissSuggestion(s) } }
                                    .buttonStyle(.borderless)
                            }
                            .disabled(busyKey != nil)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            roleSection("项目 Owner", groups.owners)
            roleSection("领域角色", groups.domains)
            roleSection("跨项目角色", groups.cross)
            roleSection("人建的角色", groups.manual)
            if loaded, roles.isEmpty, error == nil {
                Section { Text("还没有角色。往一个 git 仓库派任务，就会自动生成它的项目 Owner").caption() }
            }
            if !roles.isEmpty {
                Section { Text("点角色 = 派任务给它（自动填好它的工作目录）。原则、决策等长期记忆在网页「角色」页维护").caption() }
            }
        }
        .scrollContentBackground(.hidden)
        .background(OW.bg)
        .navigationTitle("角色")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .refreshable { Haptics.tap(); await load() }
        .task { await load() }
    }

    @ViewBuilder
    private func roleSection(_ title: String, _ list: [AgentRole]) -> some View {
        if !list.isEmpty {
            Section(title) {
                ForEach(list) { r in
                    // 冲突的角色服务端一概拒绝操作：照样列出来（藏掉等于让那份记忆凭空消失），但点不进去
                    Button {
                        Haptics.tap(); openDispatch(r.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(r.name.isEmpty ? r.id : r.name).font(.owBodyM).foregroundStyle(OW.text).lineLimit(1)
                            Text(r.conflict ? "⚠️ " + (r.conflictMsg.isEmpty ? "这个角色有歧义，先在网页角色页处理" : r.conflictMsg) : roleSub(r))
                                .font(.owLabelS).foregroundStyle(r.conflict ? OW.danger : OW.textDim).lineLimit(1)
                        }
                    }
                    .disabled(r.conflict)
                }
            }
        }
    }

    private func load() async {
        do {
            let r = try await client.roles()
            roles = r.roles
            supported = r.dispatchRole
            // 建议是锦上添花：拿不到不算错，列表照常用
            suggestions = r.dispatchRole ? ((try? await client.roleSuggestions().suggestions) ?? []) : []
            error = nil
        } catch {
            self.error = error.userMessage
        }
        loaded = true
    }

    private func accept(_ s: RoleSuggestion) async {
        guard busyKey == nil else { return }
        busyKey = s.key
        defer { busyKey = nil }
        do {
            let r = try await client.createCrossRole(dirs: s.dirs)
            guard r.ok else { error = r.msg.isEmpty ? "没建成" : r.msg; Haptics.error(); return }
            Haptics.success()
            await load()
        } catch {
            self.error = error.userMessage; Haptics.error()
        }
    }

    private func dismissSuggestion(_ s: RoleSuggestion) async {
        guard busyKey == nil else { return }
        busyKey = s.key
        defer { busyKey = nil }
        do {
            try await client.dismissRoleSuggestion(key: s.key).requireOk("忽略失败")
            withAnimation(.snappy) { suggestions.removeAll { $0.key == s.key } }
        } catch {
            self.error = error.userMessage; Haptics.error()
        }
    }
}
