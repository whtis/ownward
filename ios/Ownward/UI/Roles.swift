// 「谁来接这个任务」的规则（src/role-auto.ts 的手机端，对齐 android ui/Roles.kt）。与 web/app.js 的
// renderWorkRoleHint 同口径，配对单测 RolesTests.swift ↔ RolesTest.kt 用同一张预期表——
// 三端各写一份最容易漂成三种说法，所以纯逻辑单独成文件，不碰 SwiftUI。
import Foundation

let roleAuto = "auto"
let roleNone = "none"

/// 展示叫法：自动建的项目专家就是这个项目的 Owner，自动建的 lead 管的是几个项目之间的事，不是某个职能；
/// 领域角色管没有仓库的那类活（形状上是项目专家，叫法先看 origin）
func roleKindLabel(_ role: AgentRole) -> String {
    if role.origin == "domain" { return "领域角色" }
    return role.type == "project"
        ? (role.origin == "auto" ? "项目 Owner" : "项目专家")
        : (role.origin == "auto" ? "跨项目角色" : "职能负责人")
}

func scopeLabel(_ scope: String) -> String {
    switch scope {
    case "work": "工作"
    case "private": "私人"
    default: ""
    }
}

/// 角色下拉的三组：项目角色 / 领域角色 / 跨项目角色（下拉里按这个顺序排）
struct DispatchableRoles: Equatable {
    var projects: [AgentRole]
    var domains: [AgentRole]
    var cross: [AgentRole]
}

/// 派发时能点名的角色：在岗、无冲突（冲突的服务端一概拒绝）；领域角色形状上也是 type=project，单独一组
func dispatchableRoles(_ roles: [AgentRole]) -> DispatchableRoles {
    let usable = roles.filter { $0.status != "archived" && !$0.conflict }
    return DispatchableRoles(
        projects: usable.filter { $0.type == "project" && $0.origin != "domain" },
        domains: usable.filter { $0.origin == "domain" },
        cross: usable.filter { $0.type != "project" }
    )
}

/// 角色选择器上显示的当前值
func roleChoiceLabel(_ choice: String, roles: [AgentRole]) -> String {
    switch choice {
    case roleAuto: return "自动匹配（推荐）"
    case roleNone: return "不用角色"
    default:
        guard let r = roles.first(where: { $0.id == choice }) else { return choice }
        return r.name.isEmpty ? r.id : r.name
    }
}

enum HintTone: Equatable, Sendable { case plain, new, warn }

struct RoleHint: Equatable, Sendable {
    var text: String
    var tone: HintTone = .plain
}

/// 角色那一行下面的一句话：这次会带上谁的记忆
func roleHint(_ choice: String, preview: RolePreview?, roles: [AgentRole], dirBlank: Bool) -> RoleHint {
    if choice == roleNone { return RoleHint(text: "不带角色记忆，agent 从零了解项目") }
    if choice != roleAuto {
        guard let r = roles.first(where: { $0.id == choice }) else {
            return RoleHint(text: "这个角色读不到了，刷新一下", tone: .warn)
        }
        return RoleHint(text: "由「\(r.name.isEmpty ? r.id : r.name)」接手 · \(roleKindLabel(r))")
    }
    guard let preview else { return RoleHint(text: dirBlank ? "选好目录后自动匹配这个项目的 Owner" : "正在匹配…") }
    let auto = preview.auto ?? RoleAutoPick()
    if !auto.roleId.isEmpty, auto.by == "task" {
        return RoleHint(text: "由「\(auto.name)」接手 · 按任务描述匹配" + (auto.why.isEmpty ? "" : "（\(auto.why)）"))
    }
    if !auto.roleId.isEmpty { return RoleHint(text: "由「\(auto.name)」接手") }
    if auto.willCreate { return RoleHint(text: "将自动生成「\(auto.name)」接手——这个项目还没有 Owner", tone: .new) }
    // 拿不准由哪个领域角色接：服务端派发时不替人挑，得手选（下面摆出候选）
    if !auto.candidates.isEmpty {
        return RoleHint(text: auto.reason.isEmpty ? "拿不准由哪个领域角色接，手选一个" : auto.reason, tone: .warn)
    }
    // 还没写任务描述、都不像任何领域角色……服务端在 reason 里说
    return RoleHint(text: auto.reason.isEmpty ? "这次不带角色" : auto.reason)
}

/// 「自动」拿不准由哪个领域角色接时，摆在提示下面让人点的候选；点名了角色或不用角色就不摆
func rolePickCandidates(_ choice: String, preview: RolePreview?) -> [RoleRefLite] {
    guard choice == roleAuto else { return [] }
    return preview?.auto?.candidates ?? []
}

/// 拿不准还选着「自动」：得先手选（提交时怎么拦见 roleSubmit）
func needsManualPick(_ choice: String, preview: RolePreview?) -> Bool {
    !rolePickCandidates(choice, preview: preview).isEmpty
}

/// 这份预览是按任务描述匹配的（主目录不是仓库）：任务描述一变就得重新预览
func previewByTask(_ preview: RolePreview?) -> Bool {
    preview?.auto?.by == "task"
}

/// 提交时拿不准拦下来的那句（roleSubmit）
let rolePickRequired = "拿不准由哪个领域角色接，先在「角色」里选一个（或选「不用角色」）"
/// 提交时描述改了、新的预览还没回来拦下来的那句（roleSubmit）
let roleMatchingMsg = "正在按新的任务描述匹配角色，稍等一下再派"

/// 提交时 /api/work 的 role 键怎么发：send(nil) = 不发（服务端缺省 auto）；block = 先不派，msg 给人看
enum RoleSubmit: Equatable, Sendable {
    case send(role: String?)
    case block(msg: String)
}

/// 派出去的角色 = 预览给人看的角色：按描述匹配上的点名发过去，别让服务端再判一次——
/// 重判可能落到别处（描述后面拼了附件路径），也可能超时就不带角色了。
/// previewTask = 最近一次完成的预览请求带的描述，currentTask = 输入框当前的描述（都去掉首尾空白，不是待命开场白）
func roleSubmit(choice: String, preview: RolePreview?, byTask: Bool, previewTask: String, currentTask: String,
                supported: Bool) -> RoleSubmit {
    // 老 daemon 不认 role 键；点名的（none / 角色 id）照发
    if !supported || choice != roleAuto { return .send(role: dispatchRoleParam(choice, supported: supported)) }
    // 不是按描述匹配的（按目录定，服务端算出来的是同一个）；描述留空走待命开场，服务端不拿它匹配
    if !byTask || currentTask.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .send(role: nil) }
    // 描述改了、新的预览还没回来（重新预览期间 preview 是清空的）
    guard let preview, previewTask == currentTask else { return .block(msg: roleMatchingMsg) }
    let auto = preview.auto ?? RoleAutoPick()
    if !auto.candidates.isEmpty { return .block(msg: rolePickRequired) }   // 拿不准：服务端不替人挑
    if !auto.roleId.isEmpty { return .send(role: auto.roleId) }
    return .send(role: nil)   // 都不像：不带角色
}

func crossKey(_ cross: RoleCross) -> String { cross.slugs.joined(separator: "+") }

/// 跨项目提示：只在「自动」时问——用户点名了某个角色，就别再劝他换；这次点过「不用」的组合不再问
func crossPrompt(_ choice: String, preview: RolePreview?, skipped: Set<String>) -> RoleCross? {
    guard let cross = preview?.cross, choice == roleAuto, !skipped.contains(crossKey(cross)) else { return nil }
    return cross
}

func crossPromptText(_ cross: RoleCross) -> String {
    cross.possible
        ? "这次任务跨了 \(cross.labels.count) 个项目（\(cross.labels.joined(separator: "、"))），还没有角色同时管它们。要建一个能同时读这几个项目记忆的角色来接吗？"
        : "\(cross.reason)，这次只带主项目的记忆"
}

/// 点名一个角色：它登记了工作目录就替人填好——第一个当主目录，其余当附加目录
func roleDirs(_ role: AgentRole) -> (dir: String, extras: [String])? {
    let dirs = role.dirs.filter { !$0.isEmpty }
    guard let first = dirs.first else { return nil }
    return (first, Array(dirs.dropFirst()))
}

/// /api/work 的 role 键：老 daemon 不认（键白名单整包 400）就一律不发；「自动」是服务端缺省，也不发
func dispatchRoleParam(_ choice: String, supported: Bool) -> String? {
    supported && choice != roleAuto ? choice : nil
}

/// 角色页的四组：自动建的项目 Owner / 领域角色 / 自动建的跨项目角色 / 人建的（两种类型都算）
struct RoleGroups: Equatable {
    var owners: [AgentRole]
    var domains: [AgentRole]
    var cross: [AgentRole]
    var manual: [AgentRole]
}

func groupRoles(_ roles: [AgentRole]) -> RoleGroups {
    let live = roles.filter { $0.status != "archived" }
    return RoleGroups(
        owners: live.filter { $0.origin == "auto" && $0.type == "project" },
        domains: live.filter { $0.origin == "domain" },
        cross: live.filter { $0.origin == "auto" && $0.type != "project" },
        manual: live.filter { $0.origin != "auto" && $0.origin != "domain" }
    )
}

/// 角色行的副标题：叫法 · 工作/私人 · 主项目（项目角色）或关联几个项目。
/// 领域角色不带尾巴：它的主项目是 vault 里的虚拟项目，对人没意义
func roleSub(_ role: AgentRole) -> String {
    let tail = role.origin == "domain" ? ""
        : role.type == "project" ? role.primaryProject : (role.projects.isEmpty ? "" : "\(role.projects.count) 个项目")
    return [roleKindLabel(role), scopeLabel(role.scope), tail].filter { !$0.isEmpty }.joined(separator: " · ")
}

func suggestionSub(_ s: RoleSuggestion) -> String {
    let scope = scopeLabel(s.scope)
    return "\(s.count) 次任务同时动了这几个项目\(scope.isEmpty ? "" : " · \(scope)")，还没有角色同时管它们"
}
