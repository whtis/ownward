package ai.ownward.app.ui

import ai.ownward.app.data.AgentRole
import ai.ownward.app.data.DevMsg
import ai.ownward.app.data.RoleAutoPick
import ai.ownward.app.data.RoleCross
import ai.ownward.app.data.RolePreview
import ai.ownward.app.data.RoleRefLite
import ai.ownward.app.data.RoleSuggestion
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// 「谁来接」的规则：与 ios OwnwardTests/RolesTests.swift 逐条配对、同一张预期表（也是 web/app.js renderWorkRoleHint 的说法）
class RolesTest {
    private val owner = AgentRole(id = "owner-acme-app", name = "acme-app Owner", type = "project", origin = "auto",
        scope = "work", primaryProject = "acme-app", projects = listOf("acme-app"), dirs = listOf("/w/acme-app"))
    private val cross = AgentRole(id = "cross-a-b", name = "a + b", type = "lead", origin = "auto",
        projects = listOf("a", "b"), dirs = listOf("/w/a", "/w/b"))
    private val lead = AgentRole(id = "dev", name = "研发三杠一", type = "lead", projects = listOf("a", "b", "c"))
    private val expert = AgentRole(id = "ownward-dev", name = "我的专家", type = "project", primaryProject = "ownward")
    private val broken = AgentRole(id = "dup", name = "冲突的", type = "project", origin = "auto", conflict = true)
    private val archived = AgentRole(id = "old", name = "归档的", type = "project", origin = "auto", status = "archived")
    private val roles = listOf(owner, cross, lead, expert, broken, archived)

    @Test fun kindLabels() {
        assertEquals("项目 Owner", roleKindLabel(owner))
        assertEquals("跨项目角色", roleKindLabel(cross))
        assertEquals("职能负责人", roleKindLabel(lead))
        assertEquals("项目专家", roleKindLabel(expert))
    }

    @Test fun pickerListsOnlyUsableRolesProjectFirst() {
        val g = dispatchableRoles(roles)
        assertEquals(listOf("owner-acme-app", "ownward-dev"), g.projects.map { it.id })
        assertEquals(emptyList<AgentRole>(), g.domains)
        assertEquals(listOf("cross-a-b", "dev"), g.cross.map { it.id })
    }

    @Test fun choiceLabels() {
        assertEquals("自动匹配（推荐）", roleChoiceLabel(ROLE_AUTO, roles))
        assertEquals("不用角色", roleChoiceLabel(ROLE_NONE, roles))
        assertEquals("acme-app Owner", roleChoiceLabel("owner-acme-app", roles))
        assertEquals("ghost", roleChoiceLabel("ghost", roles))
    }

    @Test fun hintTable() {
        fun preview(id: String = "", name: String = "", willCreate: Boolean = false, reason: String = "") =
            RolePreview(ok = true, auto = RoleAutoPick(id, name, willCreate, reason))
        assertEquals(RoleHint("不带角色记忆，agent 从零了解项目"), roleHint(ROLE_NONE, null, roles, false))
        assertEquals(RoleHint("由「acme-app Owner」接手 · 项目 Owner"), roleHint("owner-acme-app", null, roles, false))
        assertEquals(RoleHint("这个角色读不到了，刷新一下", HintTone.Warn), roleHint("ghost", null, roles, false))
        assertEquals(RoleHint("选好目录后自动匹配这个项目的 Owner"), roleHint(ROLE_AUTO, null, roles, true))
        assertEquals(RoleHint("正在匹配…"), roleHint(ROLE_AUTO, null, roles, false))
        assertEquals(RoleHint("由「acme-app Owner」接手"), roleHint(ROLE_AUTO, preview("owner-acme-app", "acme-app Owner"), roles, false))
        assertEquals(
            RoleHint("将自动生成「beta Owner」接手——这个项目还没有 Owner", HintTone.New),
            roleHint(ROLE_AUTO, preview(name = "beta Owner", willCreate = true), roles, false),
        )
        assertEquals(RoleHint("主目录不是 git 仓库（或是 vault 本身），没有项目 Owner"),
            roleHint(ROLE_AUTO, preview(reason = "主目录不是 git 仓库（或是 vault 本身），没有项目 Owner"), roles, false))
        assertEquals(RoleHint("这次不带角色"), roleHint(ROLE_AUTO, preview(), roles, false))
    }

    @Test fun crossPromptOnlyForAutoAndNotAfterSkip() {
        val c = RoleCross(possible = true, name = "a + b", labels = listOf("a", "b"), slugs = listOf("a", "b"), dirs = listOf("/w/a", "/w/b"))
        val p = RolePreview(ok = true, cross = c)
        assertEquals(c, crossPrompt(ROLE_AUTO, p, emptySet()))
        assertNull(crossPrompt("owner-acme-app", p, emptySet()))   // 点名了角色就别劝他换
        assertNull(crossPrompt(ROLE_AUTO, p, setOf("a+b")))         // 这次点过「不用」
        assertNull(crossPrompt(ROLE_AUTO, RolePreview(ok = true), emptySet()))
        assertEquals("这次任务跨了 2 个项目（a、b），还没有角色同时管它们。要建一个能同时读这几个项目记忆的角色来接吗？", crossPromptText(c))
        assertEquals("这几个项目分属工作和私人，合不成一个角色，这次只带主项目的记忆",
            crossPromptText(RoleCross(possible = false, reason = "这几个项目分属工作和私人，合不成一个角色")))
    }

    @Test fun namedRoleFillsItsDirs() {
        assertEquals("/w/a" to listOf("/w/b"), roleDirs(cross))
        assertEquals("/w/acme-app" to emptyList<String>(), roleDirs(owner))
        assertNull(roleDirs(lead))   // 人建的角色没登记目录：派发页自己选
    }

    @Test fun roleKeyIsOnlySentWhenServerSupportsItAndUserNamedOne() {
        assertNull(dispatchRoleParam(ROLE_AUTO, true))           // 自动 = 服务端缺省
        assertEquals("none", dispatchRoleParam(ROLE_NONE, true))
        assertEquals("dev", dispatchRoleParam("dev", true))
        assertNull(dispatchRoleParam("dev", false))              // 老 daemon 的 /api/work 不认 role 键
    }

    @Test fun rolesPageGroupsAndSubtitles() {
        val g = groupRoles(roles)
        assertEquals(listOf("owner-acme-app", "dup"), g.owners.map { it.id })   // 冲突的照样列（标出来），归档的不列
        assertEquals(listOf("cross-a-b"), g.cross.map { it.id })
        assertEquals(listOf("dev", "ownward-dev"), g.manual.map { it.id })
        assertEquals("项目 Owner · 工作 · acme-app", roleSub(owner))
        assertEquals("职能负责人 · 3 个项目", roleSub(lead))
        assertEquals("2 次任务同时动了这几个项目 · 工作，还没有角色同时管它们",
            suggestionSub(RoleSuggestion(key = "work|a+b", scope = "work", count = 2)))
        assertEquals("1 次任务同时动了这几个项目，还没有角色同时管它们", suggestionSub(RoleSuggestion(key = "|a+b", count = 1)))
    }

    // ---- 领域角色：管没有仓库的那类活（主目录不是仓库时按任务描述匹配）----
    private val domain = AgentRole(id = "domain-device-ops", name = "手机设备运维", type = "project", origin = "domain",
        scope = "work", primaryProject = "device-ops", projects = listOf("device-ops"), dirs = listOf("/w"))
    private val bizOps = RoleRefLite("domain-biz-ops", "业务运营")
    private val deviceOps = RoleRefLite("domain-device-ops", "手机设备运维")
    private fun auto(pick: RoleAutoPick) = RolePreview(ok = true, auto = pick)
    private val uncertain = auto(RoleAutoPick(candidates = listOf(bizOps, deviceOps), reason = "拿不准由哪个领域角色接，手选一个"))

    @Test fun domainKindLabelWinsOverType() {
        assertEquals("领域角色", roleKindLabel(AgentRole(id = "d1", type = "project", origin = "domain")))
        assertEquals("领域角色", roleKindLabel(AgentRole(id = "d2", type = "lead", origin = "domain")))
    }

    @Test fun rolesPageHasDomainGroup() {
        val owner = AgentRole(id = "owner", type = "project", origin = "auto")
        val domain = AgentRole(id = "domain", type = "project", origin = "domain")
        val cross = AgentRole(id = "cross", type = "lead", origin = "auto")
        val manual = AgentRole(id = "manual", type = "project", origin = "")
        val manualLead = AgentRole(id = "manualLead", type = "lead", origin = "")
        val archivedDomain = AgentRole(id = "archivedDomain", type = "project", origin = "domain", status = "archived")
        val g = groupRoles(listOf(owner, domain, cross, manual, manualLead, archivedDomain))
        assertEquals(listOf("owner"), g.owners.map { it.id })
        assertEquals(listOf("domain"), g.domains.map { it.id })
        assertEquals(listOf("cross"), g.cross.map { it.id })
        assertEquals(listOf("manual", "manualLead"), g.manual.map { it.id })
    }

    @Test fun domainSubHasNoVirtualProjectTail() {
        assertEquals("领域角色 · 工作", roleSub(domain))
    }

    @Test fun domainHintTable() {
        // 按任务描述匹配上了：带一句依据（没有就不带括号）
        assertEquals(RoleHint("由「手机设备运维」接手 · 按任务描述匹配（提到云客手机）"),
            roleHint(ROLE_AUTO, auto(RoleAutoPick(roleId = "domain-device-ops", name = "手机设备运维", by = "task", why = "提到云客手机")), roles, false))
        assertEquals(RoleHint("由「手机设备运维」接手 · 按任务描述匹配"),
            roleHint(ROLE_AUTO, auto(RoleAutoPick(roleId = "domain-device-ops", name = "手机设备运维", by = "task")), roles, false))
        // 拿不准：要人手选，标成警示
        assertEquals(RoleHint("拿不准由哪个领域角色接，手选一个", HintTone.Warn), roleHint(ROLE_AUTO, uncertain, roles, false))
        assertEquals(RoleHint("拿不准由哪个领域角色接，手选一个", HintTone.Warn),
            roleHint(ROLE_AUTO, auto(RoleAutoPick(candidates = listOf(bizOps, deviceOps))), roles, false))
        // 还没写任务描述：服务端给的说法，不算警示
        assertEquals(RoleHint("主目录不是仓库：写好任务描述后按描述匹配领域角色"),
            roleHint(ROLE_AUTO, auto(RoleAutoPick(by = "task", needsTask = true, reason = "主目录不是仓库：写好任务描述后按描述匹配领域角色")), roles, false))
    }

    @Test fun manualPickOnlyWhenAutoAndUncertain() {
        assertTrue(needsManualPick(ROLE_AUTO, uncertain))
        assertFalse(needsManualPick("domain-biz-ops", uncertain))   // 已经点名了
        assertFalse(needsManualPick(ROLE_AUTO, auto(RoleAutoPick(roleId = "domain-device-ops", name = "手机设备运维", by = "task"))))
        assertEquals(listOf(bizOps, deviceOps), rolePickCandidates(ROLE_AUTO, uncertain))
        assertEquals(emptyList<RoleRefLite>(), rolePickCandidates(ROLE_NONE, uncertain))
    }

    @Test fun domainRolesAreTheirOwnPickerGroup() {
        val g = dispatchableRoles(roles + domain)
        assertEquals(listOf("domain-device-ops"), g.domains.map { it.id })
        assertFalse(g.projects.any { it.id == "domain-device-ops" })
    }

    @Test fun previewByTaskOnlyWhenServerSaysSo() {
        assertTrue(previewByTask(auto(RoleAutoPick(by = "task", needsTask = true))))
        assertFalse(previewByTask(auto(RoleAutoPick(roleId = "owner-acme-app", name = "acme-app Owner"))))
        assertFalse(previewByTask(null))
    }

    // 派出去的角色 = 预览给人看的角色（与 RolesTests.swift 同一张表，序号对应补充规格）
    @Test fun submitSendsWhatThePreviewShowed() {
        val same = "云客手机掉线了"
        fun submit(choice: String = ROLE_AUTO, preview: RolePreview? = null, byTask: Boolean = true,
                   previewTask: String = same, currentTask: String = same, supported: Boolean = true) =
            roleSubmit(choice, preview, byTask, previewTask, currentTask, supported)
        val matched = auto(RoleAutoPick(roleId = "domain-device-ops", name = "手机设备运维", by = "task"))
        val noMatch = auto(RoleAutoPick(by = "task", reason = "不像任何一个领域角色的活，这次不带角色"))
        // 1. 老 daemon：一律不发 role 键
        assertEquals(RoleSubmit.Send(null), submit(preview = uncertain, supported = false))
        // 2. 点名的（含不用角色）照发，预览拿不准也一样
        assertEquals(RoleSubmit.Send("none"), submit(choice = ROLE_NONE, preview = uncertain))
        assertEquals(RoleSubmit.Send("domain-x"), submit(choice = "domain-x", preview = uncertain))
        // 3. 不是按描述匹配 / 描述留空：交给服务端缺省
        assertEquals(RoleSubmit.Send(null), submit(preview = uncertain, byTask = false))
        assertEquals(RoleSubmit.Send(null), submit(preview = uncertain, currentTask = ""))
        // 4–5. 新描述的预览还没回来
        assertEquals(RoleSubmit.Block(ROLE_MATCHING_MSG), submit(preview = null))
        assertEquals(RoleSubmit.Block(ROLE_MATCHING_MSG), submit(preview = matched, previewTask = "旧描述", currentTask = "新描述"))
        // 6. 拿不准：先手选
        assertEquals(RoleSubmit.Block("拿不准由哪个领域角色接，先在「角色」里选一个（或选「不用角色」）"), submit(preview = uncertain))
        // 7. 匹配上了：点名发它
        assertEquals(RoleSubmit.Send("domain-device-ops"), submit(preview = matched))
        // 8. 都不像：不带角色
        assertEquals(RoleSubmit.Send(null), submit(preview = noMatch))
        assertEquals("正在按新的任务描述匹配角色，稍等一下再派", ROLE_MATCHING_MSG)
    }

    @Test fun roleNoticeIsItsOwnLineNotAToolRow() {
        val notice = DevMsg(role = "system", name = "role", text = "已带上角色「x」的记忆")
        assertTrue(notice.isRoleNotice())
        assertFalse(DevMsg(role = "system", name = "handoff").isRoleNotice())
        assertFalse(DevMsg(role = "user", text = "x").isRoleNotice())
        // 夹在工具行中间也不会被折进组里（只有 role=tool 才折）
        val tools = List(3) { DevMsg(role = "tool", name = "Bash") }
        val items = foldToolRuns(listOf(notice) + tools)
        assertTrue(items[0] is FeedItem.One)
        assertTrue(items[1] is FeedItem.Tools)
    }
}
