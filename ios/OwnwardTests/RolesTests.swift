// 「谁来接」的规则（对齐 android ui/RolesTest.kt，逐条配对、同一张预期表；也是 web/app.js renderWorkRoleHint 的说法）
import Foundation
import Testing
@testable import Ownward

private let owner = AgentRole(id: "owner-acme-app", name: "acme-app Owner", type: "project", origin: "auto",
                              scope: "work", primaryProject: "acme-app", projects: ["acme-app"], dirs: ["/w/acme-app"])
private let cross = AgentRole(id: "cross-a-b", name: "a + b", type: "lead", origin: "auto",
                              projects: ["a", "b"], dirs: ["/w/a", "/w/b"])
private let lead = AgentRole(id: "dev", name: "研发三杠一", type: "lead", projects: ["a", "b", "c"])
private let expert = AgentRole(id: "ownward-dev", name: "我的专家", type: "project", primaryProject: "ownward")
private let broken = AgentRole(id: "dup", name: "冲突的", type: "project", origin: "auto", conflict: true)
private let archived = AgentRole(id: "old", name: "归档的", type: "project", origin: "auto", status: "archived")
private let roles = [owner, cross, lead, expert, broken, archived]
// 领域角色：管没有仓库的活，形状上是 type=project，primaryProject 是 vault 里的虚拟项目
private let domain = AgentRole(id: "domain-device-ops", name: "手机设备运维", type: "project", origin: "domain",
                               scope: "work", primaryProject: "device-ops", dirs: ["~/workspace"])
private let domainLead = AgentRole(id: "domain-lead", name: "领域 lead", type: "lead", origin: "domain")
private let archivedDomain = AgentRole(id: "domain-old", name: "归档的领域角色", type: "project", origin: "domain", status: "archived")
private let candidates = [RoleRefLite(id: "domain-biz-ops", name: "业务运营"), RoleRefLite(id: "domain-device-ops", name: "手机设备运维")]

private func preview(_ id: String = "", _ name: String = "", willCreate: Bool = false, reason: String = "") -> RolePreview {
    RolePreview(ok: true, auto: RoleAutoPick(roleId: id, name: name, willCreate: willCreate, reason: reason))
}

private let matched = RolePreview(ok: true, auto: RoleAutoPick(roleId: "domain-device-ops", name: "手机设备运维", by: "task", why: "提到云客手机"))
private let unsure = RolePreview(ok: true, auto: RoleAutoPick(reason: "拿不准由哪个领域角色接，手选一个", by: "task", candidates: candidates))

/// roleSubmit 的缺省局面：选着「自动」、上一份是按描述匹配的、预览就是按眼下这段描述问的、服务端收 role 键
private func submit(_ choice: String = roleAuto, _ preview: RolePreview?, byTask: Bool = true, previewTask: String = "看看云客手机",
                    currentTask: String = "看看云客手机", supported: Bool = true) -> RoleSubmit {
    roleSubmit(choice: choice, preview: preview, byTask: byTask, previewTask: previewTask, currentTask: currentTask, supported: supported)
}

struct RolesTests {
    @Test func 叫法() {
        #expect(roleKindLabel(owner) == "项目 Owner")
        #expect(roleKindLabel(cross) == "跨项目角色")
        #expect(roleKindLabel(lead) == "职能负责人")
        #expect(roleKindLabel(expert) == "项目专家")
    }

    @Test func 选择器只列能用的角色且项目角色在前() {
        let g = dispatchableRoles(roles)
        #expect(g.projects.map(\.id) == ["owner-acme-app", "ownward-dev"])
        #expect(g.domains.isEmpty)
        #expect(g.cross.map(\.id) == ["cross-a-b", "dev"])
    }

    @Test func 选择器里领域角色单独一组() {
        let g = dispatchableRoles(roles + [domain, archivedDomain])
        #expect(g.domains.map(\.id) == ["domain-device-ops"])                  // 归档的不列
        #expect(g.projects.map(\.id) == ["owner-acme-app", "ownward-dev"])    // 形状上是 type=project，但不进项目角色
    }

    @Test func 领域角色的叫法与副标题() {
        #expect(roleKindLabel(domain) == "领域角色")
        #expect(roleKindLabel(domainLead) == "领域角色")   // 叫法先看 origin，不看 type
        #expect(roleSub(domain) == "领域角色 · 工作")       // 虚拟项目对人没意义，不带尾巴
    }

    @Test func 角色页领域角色单独一组() {
        let g = groupRoles([owner, domain, cross, expert, lead, archivedDomain])
        #expect(g.owners.map(\.id) == ["owner-acme-app"])
        #expect(g.domains.map(\.id) == ["domain-device-ops"])   // 归档的不列
        #expect(g.cross.map(\.id) == ["cross-a-b"])
        #expect(g.manual.map(\.id) == ["ownward-dev", "dev"])
    }

    @Test func 按任务描述匹配的说明句() {
        #expect(roleHint(roleAuto, preview: matched, roles: roles, dirBlank: false)
            == RoleHint(text: "由「手机设备运维」接手 · 按任务描述匹配（提到云客手机）"))
        let noWhy = RolePreview(ok: true, auto: RoleAutoPick(roleId: "domain-device-ops", name: "手机设备运维", by: "task"))
        #expect(roleHint(roleAuto, preview: noWhy, roles: roles, dirBlank: false) == RoleHint(text: "由「手机设备运维」接手 · 按任务描述匹配"))
        // 拿不准：文案服务端给，没给用兜底；都是 warn
        #expect(roleHint(roleAuto, preview: unsure, roles: roles, dirBlank: false)
            == RoleHint(text: "拿不准由哪个领域角色接，手选一个", tone: .warn))
        let bare = RolePreview(ok: true, auto: RoleAutoPick(by: "task", candidates: candidates))
        #expect(roleHint(roleAuto, preview: bare, roles: roles, dirBlank: false)
            == RoleHint(text: "拿不准由哪个领域角色接，手选一个", tone: .warn))
        let failed = RolePreview(ok: true, auto: RoleAutoPick(reason: "没判断出该由哪个领域角色接，手选一个", by: "task", candidates: candidates))
        #expect(roleHint(roleAuto, preview: failed, roles: roles, dirBlank: false)
            == RoleHint(text: "没判断出该由哪个领域角色接，手选一个", tone: .warn))
        // 还没写任务描述：服务端的 reason 原样，普通语气
        let needsTask = RolePreview(ok: true, auto: RoleAutoPick(reason: "主目录不是仓库：写好任务描述后按描述匹配领域角色", by: "task", needsTask: true))
        #expect(roleHint(roleAuto, preview: needsTask, roles: roles, dirBlank: false)
            == RoleHint(text: "主目录不是仓库：写好任务描述后按描述匹配领域角色"))
        // 点了候选之后
        #expect(roleHint("domain-device-ops", preview: unsure, roles: roles + [domain], dirBlank: false)
            == RoleHint(text: "由「手机设备运维」接手 · 领域角色"))
    }

    @Test func 拿不准时摆候选且不许按自动提交() {
        #expect(needsManualPick(roleAuto, preview: unsure))
        #expect(!needsManualPick("domain-device-ops", preview: unsure))   // 点名了角色
        #expect(!needsManualPick(roleAuto, preview: matched))             // 没有候选
        #expect(rolePickCandidates(roleAuto, preview: unsure) == candidates)
        #expect(rolePickCandidates(roleNone, preview: unsure) == [])
        #expect(rolePickRequired == "拿不准由哪个领域角色接，先在「角色」里选一个（或选「不用角色」）")
    }

    @Test func 预览是不是按任务描述匹配的() {
        #expect(previewByTask(matched))
        #expect(!previewByTask(preview("owner-acme-app", "acme-app Owner")))   // 没有 by
        #expect(!previewByTask(nil))
    }

    @Test func 派出去的角色就是预览给人看的角色() {
        // 1. 老 daemon 不认 role 键：一律不发
        #expect(submit(roleAuto, unsure, supported: false) == .send(role: nil))
        #expect(submit("domain-x", unsure, supported: false) == .send(role: nil))
        // 2. 点名的照发，即使预览拿不准
        #expect(submit(roleNone, unsure) == .send(role: "none"))
        #expect(submit("domain-x", unsure) == .send(role: "domain-x"))
        // 3. 不是按描述匹配的（按目录定）；描述留空走待命开场——都交给服务端
        #expect(submit(roleAuto, preview("owner-acme-app", "acme-app Owner"), byTask: false) == .send(role: nil))
        #expect(submit(roleAuto, nil, currentTask: "") == .send(role: nil))
        #expect(submit(roleAuto, nil, currentTask: "  ") == .send(role: nil))
        // 4. 重新预览期间 preview 是清空的
        #expect(submit(roleAuto, nil) == .block(msg: roleMatchingMsg))
        // 5. 描述改了、新的预览还没回来
        #expect(submit(roleAuto, matched, previewTask: "旧描述", currentTask: "新描述") == .block(msg: roleMatchingMsg))
        // 6. 拿不准
        #expect(submit(roleAuto, unsure) == .block(msg: rolePickRequired))
        // 7. 匹配上了：点名发过去，别让服务端再判一次
        #expect(submit(roleAuto, matched) == .send(role: "domain-device-ops"))
        // 8. 都不像：不带角色
        let nothing = RolePreview(ok: true, auto: RoleAutoPick(reason: "不像任何一个领域角色的活，这次不带角色", by: "task"))
        #expect(submit(roleAuto, nothing) == .send(role: nil))
        #expect(roleMatchingMsg == "正在按新的任务描述匹配角色，稍等一下再派")
    }

    @Test func 选择器显示值() {
        #expect(roleChoiceLabel(roleAuto, roles: roles) == "自动匹配（推荐）")
        #expect(roleChoiceLabel(roleNone, roles: roles) == "不用角色")
        #expect(roleChoiceLabel("owner-acme-app", roles: roles) == "acme-app Owner")
        #expect(roleChoiceLabel("ghost", roles: roles) == "ghost")
    }

    @Test func 说明句预期表() {
        #expect(roleHint(roleNone, preview: nil, roles: roles, dirBlank: false) == RoleHint(text: "不带角色记忆，agent 从零了解项目"))
        #expect(roleHint("owner-acme-app", preview: nil, roles: roles, dirBlank: false) == RoleHint(text: "由「acme-app Owner」接手 · 项目 Owner"))
        #expect(roleHint("ghost", preview: nil, roles: roles, dirBlank: false) == RoleHint(text: "这个角色读不到了，刷新一下", tone: .warn))
        #expect(roleHint(roleAuto, preview: nil, roles: roles, dirBlank: true) == RoleHint(text: "选好目录后自动匹配这个项目的 Owner"))
        #expect(roleHint(roleAuto, preview: nil, roles: roles, dirBlank: false) == RoleHint(text: "正在匹配…"))
        #expect(roleHint(roleAuto, preview: preview("owner-acme-app", "acme-app Owner"), roles: roles, dirBlank: false)
            == RoleHint(text: "由「acme-app Owner」接手"))
        #expect(roleHint(roleAuto, preview: preview("", "beta Owner", willCreate: true), roles: roles, dirBlank: false)
            == RoleHint(text: "将自动生成「beta Owner」接手——这个项目还没有 Owner", tone: .new))
        #expect(roleHint(roleAuto, preview: preview(reason: "主目录不是 git 仓库（或是 vault 本身），没有项目 Owner"), roles: roles, dirBlank: false)
            == RoleHint(text: "主目录不是 git 仓库（或是 vault 本身），没有项目 Owner"))
        #expect(roleHint(roleAuto, preview: preview(), roles: roles, dirBlank: false) == RoleHint(text: "这次不带角色"))
    }

    @Test func 跨项目提示只在自动时问且点过不用就不再问() {
        let c = RoleCross(possible: true, name: "a + b", labels: ["a", "b"], slugs: ["a", "b"], dirs: ["/w/a", "/w/b"])
        let p = RolePreview(ok: true, cross: c)
        #expect(crossPrompt(roleAuto, preview: p, skipped: []) == c)
        #expect(crossPrompt("owner-acme-app", preview: p, skipped: []) == nil)   // 点名了角色就别劝他换
        #expect(crossPrompt(roleAuto, preview: p, skipped: ["a+b"]) == nil)       // 这次点过「不用」
        #expect(crossPrompt(roleAuto, preview: RolePreview(ok: true), skipped: []) == nil)
        #expect(crossPromptText(c) == "这次任务跨了 2 个项目（a、b），还没有角色同时管它们。要建一个能同时读这几个项目记忆的角色来接吗？")
        #expect(crossPromptText(RoleCross(possible: false, reason: "这几个项目分属工作和私人，合不成一个角色"))
            == "这几个项目分属工作和私人，合不成一个角色，这次只带主项目的记忆")
    }

    @Test func 点名角色带上它的目录() {
        #expect(roleDirs(cross)?.dir == "/w/a")
        #expect(roleDirs(cross)?.extras == ["/w/b"])
        #expect(roleDirs(owner)?.extras == [])
        #expect(roleDirs(lead) == nil)   // 人建的角色没登记目录：派发页自己选
    }

    @Test func role键只在服务端支持且点名时才发() {
        #expect(dispatchRoleParam(roleAuto, supported: true) == nil)   // 自动 = 服务端缺省
        #expect(dispatchRoleParam(roleNone, supported: true) == "none")
        #expect(dispatchRoleParam("dev", supported: true) == "dev")
        #expect(dispatchRoleParam("dev", supported: false) == nil)     // 老 daemon 的 /api/work 不认 role 键
    }

    @Test func 角色页分组与副标题() {
        let g = groupRoles(roles)
        #expect(g.owners.map(\.id) == ["owner-acme-app", "dup"])   // 冲突的照样列（标出来），归档的不列
        #expect(g.cross.map(\.id) == ["cross-a-b"])
        #expect(g.manual.map(\.id) == ["dev", "ownward-dev"])
        #expect(roleSub(owner) == "项目 Owner · 工作 · acme-app")
        #expect(roleSub(lead) == "职能负责人 · 3 个项目")
        #expect(suggestionSub(RoleSuggestion(key: "work|a+b", scope: "work", count: 2))
            == "2 次任务同时动了这几个项目 · 工作，还没有角色同时管它们")
        #expect(suggestionSub(RoleSuggestion(key: "|a+b", count: 1)) == "1 次任务同时动了这几个项目，还没有角色同时管它们")
    }

    @Test func 角色提示是单独一行不进工具折叠组() throws {
        let notice = try JSONDecoder().decode(DevMsg.self, from: Data(#"{"role":"system","name":"role","text":"已带上角色「x」的记忆"}"#.utf8))
        #expect(notice.isRoleNotice)
        let handoff = try JSONDecoder().decode(DevMsg.self, from: Data(#"{"role":"system","name":"handoff"}"#.utf8))
        #expect(!handoff.isRoleNotice)
        let tool = try JSONDecoder().decode(DevMsg.self, from: Data(#"{"role":"tool","name":"Bash"}"#.utf8))
        let items = foldToolRuns([notice, tool, tool, tool])
        if case .one = items[0] {} else { Issue.record("角色提示被折进了工具组") }
        if case .tools = items[1] {} else { Issue.record("后面的工具行没折起来") }
    }
}

// 接口形状（src/workbench.ts /api/roles/*、src/verticals.ts /api/work 键白名单）
struct RolesProtocolTests {
    @Test func 派发只在点名时带role与附加目录() {
        let named = OwnwardClient.dispatchBody(dir: "/w/a", task: "x", provider: "claude", worktree: true, model: nil, effort: nil,
                                               permission: "safe", images: [], role: "cross-a-b", extraDirs: ["/w/b"])
        #expect(named["role"] == .string("cross-a-b"))
        #expect(named["extraDirs"] == .array([.string("/w/b")]))
        // 自动 / 老 daemon：一个角色相关的键都不带（老 daemon 的键白名单多一个就整包 400）
        let plain = OwnwardClient.dispatchBody(dir: "/w/a", task: "x", provider: "claude", worktree: true, model: nil, effort: nil,
                                               permission: "safe", images: [], role: nil, extraDirs: [])
        #expect(plain["role"] == nil)
        #expect(plain["extraDirs"] == nil)
    }

    @Test func 能力字段与预览解码() throws {
        let fresh = try JSONDecoder().decode(RolesResponse.self, from: Data(#"{"ok":true,"roles":[{"id":"owner-a","name":"a Owner","type":"project","origin":"auto","dirs":["/w/a"],"unknown":1}],"dispatchRole":true,"autoRole":true}"#.utf8))
        #expect(fresh.dispatchRole)
        #expect(fresh.roles.first?.dirs == ["/w/a"])
        let old = try JSONDecoder().decode(RolesResponse.self, from: Data(#"{"ok":true,"roles":[{"id":"dev","name":"研发"}]}"#.utf8))
        #expect(!old.dispatchRole)                 // 老 daemon：没有能力字段
        #expect(old.roles.first?.type == "lead")   // 旧 role.json 没有 type = lead
        let p = try JSONDecoder().decode(RolePreview.self, from: Data(#"{"ok":true,"projects":[],"auto":{"roleId":"","name":"b Owner","willCreate":true,"reason":""},"cross":{"possible":true,"reason":"","name":"a + b","labels":["a","b"],"slugs":["a","b"],"dirs":["/w/a","/w/b"]}}"#.utf8))
        #expect(p.auto?.willCreate == true)
        #expect(p.cross?.slugs == ["a", "b"])
        let s = try JSONDecoder().decode([RecentSession].self, from: Data(#"[{"id":"t1","roleName":"acme-app Owner"},{"id":"t2"}]"#.utf8))
        #expect(s[0].roleName == "acme-app Owner")
        #expect(s[1].roleName == nil)
    }

    @Test func 预览请求总带任务描述() {
        // 空串也照发：主目录不是仓库时服务端按它匹配领域角色，老 daemon 的这个接口忽略不认识的键
        let blank = OwnwardClient.resolveRolesBody(dir: "/w", extraDirs: [], task: "")
        #expect(blank["task"] == .string(""))
        let body = OwnwardClient.resolveRolesBody(dir: "/w", extraDirs: ["/w/a"], task: "看看云客手机")
        #expect(body["dir"] == .string("/w"))
        #expect(body["extraDirs"] == .array([.string("/w/a")]))
        #expect(body["task"] == .string("看看云客手机"))
    }

    @Test func 领域角色预览解码() throws {
        let unsure = try JSONDecoder().decode(RolePreview.self, from: Data(#"{"ok":true,"projects":[{"dir":"/w"}],"auto":{"roleId":"","name":"","willCreate":false,"reason":"拿不准由哪个领域角色接，手选一个","by":"task","candidates":[{"id":"domain-biz-ops","name":"业务运营"},{"id":"domain-device-ops","name":"手机设备运维"}],"why":"两边都沾"},"cross":null}"#.utf8))
        #expect(unsure.auto?.by == "task")
        #expect(unsure.auto?.candidates == candidates)
        #expect(unsure.auto?.why == "两边都沾")
        #expect(unsure.auto?.needsTask == false)
        let needs = try JSONDecoder().decode(RolePreview.self, from: Data(#"{"ok":true,"projects":[{"dir":"/w"}],"auto":{"roleId":"","name":"","willCreate":false,"reason":"主目录不是仓库：写好任务描述后按描述匹配领域角色","by":"task","needsTask":true},"cross":null}"#.utf8))
        #expect(needs.auto?.needsTask == true)
        #expect(needs.auto?.candidates == [])
        // 老 daemon：auto 里没有这四个键
        let old = try JSONDecoder().decode(RolePreview.self, from: Data(#"{"ok":true,"projects":[],"auto":{"roleId":"owner-a","name":"a Owner","willCreate":false,"reason":""},"cross":null}"#.utf8))
        #expect(old.auto?.roleId == "owner-a")
        #expect(old.auto?.by == "")
        #expect(old.auto?.needsTask == false)
        #expect(old.auto?.candidates == [])
        #expect(old.auto?.why == "")
        // 角色列表里的领域角色：history（曾用名）手机端不解码，未知键忽略
        let list = try JSONDecoder().decode(RolesResponse.self, from: Data(#"{"ok":true,"roles":[{"id":"domain-device-ops","name":"手机设备运维","type":"project","origin":"domain","scope":"work","primaryProject":"device-ops","history":["设备运维"]}],"dispatchRole":true,"autoRole":true}"#.utf8))
        let d = try #require(list.roles.first)
        #expect(d.origin == "domain")
        #expect(roleSub(d) == "领域角色 · 工作")
    }
}
