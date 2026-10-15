package ai.ownward.app.ui

import ai.ownward.app.data.AgentRole
import ai.ownward.app.data.RoleCross
import ai.ownward.app.data.RolePreview
import ai.ownward.app.data.RoleRefLite
import ai.ownward.app.data.RoleSuggestion

// 「谁来接这个任务」的规则（src/role-auto.ts 的手机端）。与 web/app.js 的 renderWorkRoleHint、
// ios UI/Roles.swift 同口径，配对单测 RolesTest.kt ↔ RolesTests.swift 用同一张预期表——
// 三端各写一份最容易漂成三种说法，所以纯逻辑单独成文件，不碰 Compose，能直接在 JVM 上测。

const val ROLE_AUTO = "auto"
const val ROLE_NONE = "none"

/** 展示叫法：自动建的项目专家就是这个项目的 Owner，自动建的 lead 管的是几个项目之间的事，不是某个职能；
 *  领域角色管没有仓库的那类活（形状上是项目专家，叫法先看 origin） */
fun roleKindLabel(role: AgentRole): String = when {
    role.origin == "domain" -> "领域角色"
    role.type == "project" -> if (role.origin == "auto") "项目 Owner" else "项目专家"
    else -> if (role.origin == "auto") "跨项目角色" else "职能负责人"
}

fun scopeLabel(scope: String): String = when (scope) {
    "work" -> "工作"
    "private" -> "私人"
    else -> ""
}

/** 角色下拉的三组：项目角色 / 领域角色 / 跨项目角色（下拉里按这个顺序排） */
data class DispatchableRoles(val projects: List<AgentRole>, val domains: List<AgentRole>, val cross: List<AgentRole>)

/** 派发时能点名的角色：在岗、无冲突（冲突的服务端一概拒绝）；领域角色形状上也是 type=project，单独一组 */
fun dispatchableRoles(roles: List<AgentRole>): DispatchableRoles {
    val usable = roles.filter { it.status != "archived" && !it.conflict }
    return DispatchableRoles(
        projects = usable.filter { it.type == "project" && it.origin != "domain" },
        domains = usable.filter { it.origin == "domain" },
        cross = usable.filter { it.type != "project" },
    )
}

/** 角色选择器上显示的当前值 */
fun roleChoiceLabel(choice: String, roles: List<AgentRole>): String = when (choice) {
    ROLE_AUTO -> "自动匹配（推荐）"
    ROLE_NONE -> "不用角色"
    else -> roles.firstOrNull { it.id == choice }?.let { it.name.ifBlank { it.id } } ?: choice
}

enum class HintTone { Plain, New, Warn }

data class RoleHint(val text: String, val tone: HintTone = HintTone.Plain)

/** 角色那一行下面的一句话：这次会带上谁的记忆。
 *  按任务描述匹配（by=task）的几种未匹配状态（还没写描述 / 都不像 / 拿不准 / 模型失败），文案由服务端放在 reason 里 */
fun roleHint(choice: String, preview: RolePreview?, roles: List<AgentRole>, dirBlank: Boolean): RoleHint = when {
    choice == ROLE_NONE -> RoleHint("不带角色记忆，agent 从零了解项目")
    choice != ROLE_AUTO -> roles.firstOrNull { it.id == choice }
        ?.let { RoleHint("由「${it.name.ifBlank { it.id }}」接手 · ${roleKindLabel(it)}") }
        ?: RoleHint("这个角色读不到了，刷新一下", HintTone.Warn)
    preview == null -> RoleHint(if (dirBlank) "选好目录后自动匹配这个项目的 Owner" else "正在匹配…")
    preview.auto.roleId.isNotBlank() && preview.auto.by == "task" ->
        RoleHint("由「${preview.auto.name}」接手 · 按任务描述匹配" + (if (preview.auto.why.isBlank()) "" else "（${preview.auto.why}）"))
    preview.auto.roleId.isNotBlank() -> RoleHint("由「${preview.auto.name}」接手")
    preview.auto.willCreate -> RoleHint("将自动生成「${preview.auto.name}」接手——这个项目还没有 Owner", HintTone.New)
    preview.auto.candidates.isNotEmpty() -> RoleHint(preview.auto.reason.ifBlank { "拿不准由哪个领域角色接，手选一个" }, HintTone.Warn)
    else -> RoleHint(preview.auto.reason.ifBlank { "这次不带角色" })
}

/** 拿不准由哪个领域角色接：「自动」时把候选摆出来让人手选（派发时服务端不替人挑，会不带角色派出去） */
fun rolePickCandidates(choice: String, preview: RolePreview?): List<RoleRefLite> =
    if (choice == ROLE_AUTO) preview?.auto?.candidates.orEmpty() else emptyList()

/** 预览拿不准、选择还是「自动」：不许提交，先让人手选 */
fun needsManualPick(choice: String, preview: RolePreview?): Boolean = rolePickCandidates(choice, preview).isNotEmpty()

/** 这次预览是按任务描述匹配的：改描述要重新预览 */
fun previewByTask(preview: RolePreview?): Boolean = preview?.auto?.by == "task"

/** 提交被拦下：拿不准由哪个领域角色接，要人先手选（roleSubmit） */
const val ROLE_PICK_REQUIRED = "拿不准由哪个领域角色接，先在「角色」里选一个（或选「不用角色」）"

/** 提交被拦下：描述改了、按新描述的预览还没回来 */
const val ROLE_MATCHING_MSG = "正在按新的任务描述匹配角色，稍等一下再派"

/** 提交时 role 键怎么发：Send.role = null 就不发（服务端缺省 auto）；Block 就不提交，把 msg 给人看 */
sealed interface RoleSubmit {
    data class Send(val role: String?) : RoleSubmit
    data class Block(val msg: String) : RoleSubmit
}

/**
 * 派出去的角色 = 预览给人看的角色。按任务描述匹配（by=task）时「自动」不能原样交给服务端重判——
 * 重判可能落到别处（描述后面拼了附件路径），或等模型超时就不带角色了：预览匹配上谁，就点名发谁。
 * byTask：上一次预览是不是 by=task（重新预览、预览清空的那段时间它仍是 true——正是要拦的窗口）；
 * previewTask：最近一次完成的预览请求带的描述；currentTask：输入框里的描述（都是 trim 后，不是待命开场白）
 */
fun roleSubmit(
    choice: String, preview: RolePreview?, byTask: Boolean, previewTask: String, currentTask: String, supported: Boolean,
): RoleSubmit = when {
    !supported -> RoleSubmit.Send(null)                                   // 老 daemon 的 /api/work 不认 role 键
    choice != ROLE_AUTO -> RoleSubmit.Send(choice)                        // none 或点名的角色：照发
    !byTask || currentTask.isBlank() -> RoleSubmit.Send(null)             // 按目录匹配，或描述留空（走待命开场，服务端不拿它匹配）
    preview == null || previewTask != currentTask -> RoleSubmit.Block(ROLE_MATCHING_MSG)
    preview.auto.candidates.isNotEmpty() -> RoleSubmit.Block(ROLE_PICK_REQUIRED)
    preview.auto.roleId.isNotBlank() -> RoleSubmit.Send(preview.auto.roleId)
    else -> RoleSubmit.Send(null)
}

fun crossKey(cross: RoleCross): String = cross.slugs.joinToString("+")

/** 跨项目提示：只在「自动」时问——用户点名了某个角色，就别再劝他换；这次点过「不用」的组合不再问 */
fun crossPrompt(choice: String, preview: RolePreview?, skipped: Set<String>): RoleCross? {
    val cross = preview?.cross ?: return null
    return if (choice != ROLE_AUTO || crossKey(cross) in skipped) null else cross
}

fun crossPromptText(cross: RoleCross): String =
    if (cross.possible) "这次任务跨了 ${cross.labels.size} 个项目（${cross.labels.joinToString("、")}），还没有角色同时管它们。要建一个能同时读这几个项目记忆的角色来接吗？"
    else "${cross.reason}，这次只带主项目的记忆"

/** 点名一个角色：它登记了工作目录就替人填好——第一个当主目录，其余当附加目录 */
fun roleDirs(role: AgentRole): Pair<String, List<String>>? {
    val dirs = role.dirs.filter { it.isNotBlank() }
    return if (dirs.isEmpty()) null else dirs.first() to dirs.drop(1)
}

/** /api/work 的 role 键：老 daemon 不认（键白名单整包 400）就一律不发；「自动」是服务端缺省，也不发 */
fun dispatchRoleParam(choice: String, supported: Boolean): String? =
    if (!supported || choice == ROLE_AUTO) null else choice

/** 角色页的四组：自动建的项目 Owner / 领域角色 / 自动建的跨项目角色 / 人建的（两种类型都算） */
data class RoleGroups(val owners: List<AgentRole>, val domains: List<AgentRole>, val cross: List<AgentRole>, val manual: List<AgentRole>)

fun groupRoles(roles: List<AgentRole>): RoleGroups {
    val live = roles.filter { it.status != "archived" }
    return RoleGroups(
        owners = live.filter { it.origin == "auto" && it.type == "project" },
        domains = live.filter { it.origin == "domain" },
        cross = live.filter { it.origin == "auto" && it.type != "project" },
        manual = live.filter { it.origin != "auto" && it.origin != "domain" },
    )
}

/** 角色行的副标题：叫法 · 工作/私人 · 主项目（项目角色）或关联几个项目。
 *  领域角色不带尾巴：它的主项目是 vault 里的虚拟项目，对人没意义 */
fun roleSub(role: AgentRole): String = listOf(
    roleKindLabel(role),
    scopeLabel(role.scope),
    when {
        role.origin == "domain" -> ""
        role.type == "project" -> role.primaryProject
        role.projects.isEmpty() -> ""
        else -> "${role.projects.size} 个项目"
    },
).filter { it.isNotBlank() }.joinToString(" · ")

fun suggestionSub(s: RoleSuggestion): String {
    val scope = scopeLabel(s.scope)
    return "${s.count} 次任务同时动了这几个项目${if (scope.isEmpty()) "" else " · $scope"}，还没有角色同时管它们"
}
