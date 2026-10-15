package ai.ownward.app.data

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

// 角色接口的请求形状（src/workbench.ts /api/roles/*、src/verticals.ts 的 /api/work 键白名单）
class OwnwardClientRolesTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OwnwardClient

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
        client = OwnwardClient(server.url("/").toString(), "")
    }

    @After fun tearDown() = server.shutdown()

    @Test fun dispatchSendsRoleAndExtraDirsOnlyWhenGiven() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"ok":true,"msg":"已派发","task":{"id":"t1"}}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true,"msg":"已派发","task":{"id":"t2"}}"""))
        client.dispatchWork(dir = "/w/a", task = "x", provider = "claude", worktree = true, model = null, permission = "safe",
            role = "cross-a-b", extraDirs = listOf("/w/b"))
        client.dispatchWork(dir = "/w/a", task = "x", provider = "claude", worktree = true, model = null, permission = "safe")
        val named = server.takeRequest().body.readUtf8()
        assertTrue(named, named.endsWith(""","role":"cross-a-b","extraDirs":["/w/b"]}"""))
        // 自动 / 老 daemon：一个角色相关的键都不带（老 daemon 的键白名单多一个就整包 400）
        val plain = server.takeRequest().body.readUtf8()
        assertFalse(plain, "role" in plain)
        assertFalse(plain, "extraDirs" in plain)
    }

    @Test fun rolesCapabilityAndPreviewDecode() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"ok":true,"roles":[{"id":"owner-a","name":"a Owner","type":"project","origin":"auto","dirs":["/w/a"],"unknown":1}],"dispatchRole":true,"autoRole":true}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true,"roles":[{"id":"dev","name":"研发"}]}"""))   // 老 daemon：没有能力字段
        server.enqueue(MockResponse().setBody("""{"ok":true,"projects":[],"auto":{"roleId":"","name":"b Owner","willCreate":true,"reason":""},"cross":{"possible":true,"reason":"","name":"a + b","labels":["a","b"],"slugs":["a","b"],"dirs":["/w/a","/w/b"]}}"""))
        val fresh = client.roles()
        assertTrue(fresh.dispatchRole)
        assertEquals(listOf("/w/a"), fresh.roles.single().dirs)
        assertFalse(client.roles().dispatchRole)
        val p = client.resolveRoles("/w/a", listOf("/w/b"))
        assertTrue(p.auto.willCreate)
        assertEquals(listOf("a", "b"), p.cross?.slugs)
        server.takeRequest(); server.takeRequest()
        val resolve = server.takeRequest()
        assertEquals("/api/roles/resolve", resolve.path)
        assertEquals("""{"dir":"/w/a","extraDirs":["/w/b"],"task":""}""", resolve.body.readUtf8())   // task 空串也照发
    }

    @Test fun resolveSendsTaskAndDecodesDomainMatch() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"ok":true,"projects":[{"dir":"/w"}],"auto":{"roleId":"","name":"","willCreate":false,"by":"task","candidates":[{"id":"domain-biz-ops","name":"业务运营"},{"id":"domain-device-ops","name":"手机设备运维"}],"why":"两边都沾","reason":"拿不准由哪个领域角色接，手选一个"},"cross":null}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true,"projects":[{"dir":"/w"}],"auto":{"roleId":"","name":"","willCreate":false,"reason":"主目录不是仓库：写好任务描述后按描述匹配领域角色","by":"task","needsTask":true},"cross":null}"""))
        // 老 daemon：auto 里没有 by / needsTask / candidates / why
        server.enqueue(MockResponse().setBody("""{"ok":true,"projects":[{"dir":"/w/a"}],"auto":{"roleId":"owner-a","name":"a Owner","willCreate":false,"reason":""},"cross":null}"""))
        val uncertain = client.resolveRoles("/w", task = "云客手机掉线了")
        assertEquals("task", uncertain.auto.by)
        assertEquals(listOf(RoleRefLite("domain-biz-ops", "业务运营"), RoleRefLite("domain-device-ops", "手机设备运维")), uncertain.auto.candidates)
        assertEquals("两边都沾", uncertain.auto.why)
        assertFalse(uncertain.auto.needsTask)
        assertTrue(client.resolveRoles("/w").auto.needsTask)
        val old = client.resolveRoles("/w/a")
        assertEquals("owner-a", old.auto.roleId)
        assertEquals("", old.auto.by)
        assertFalse(old.auto.needsTask)
        assertTrue(old.auto.candidates.isEmpty())
        assertEquals("", old.auto.why)
        assertEquals("""{"dir":"/w","extraDirs":[],"task":"云客手机掉线了"}""", server.takeRequest().body.readUtf8())
        assertEquals("""{"dir":"/w","extraDirs":[],"task":""}""", server.takeRequest().body.readUtf8())
    }

    @Test fun crossRoleAndSuggestionCalls() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"ok":true,"msg":"已建「a + b」","created":true,"role":{"id":"cross-a-b","name":"a + b","type":"lead","origin":"auto"}}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true,"suggestions":[{"key":"work|a+b","scope":"work","slugs":["a","b"],"labels":["a","b"],"dirs":["/w/a","/w/b"],"count":2,"lastAt":"2026-10-01T00:00:00.000Z","name":"a + b"}]}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true,"msg":"已忽略"}"""))
        assertEquals("cross-a-b", client.createCrossRole(listOf("/w/a", "/w/b")).role?.id)
        assertEquals(2, client.roleSuggestions().suggestions.single().count)
        assertTrue(client.dismissRoleSuggestion("work|a+b").ok)
        assertEquals("""{"dirs":["/w/a","/w/b"]}""", server.takeRequest().body.readUtf8())
        assertEquals("/api/roles/suggestions", server.takeRequest().path)
        assertEquals("""{"key":"work|a+b"}""", server.takeRequest().body.readUtf8())
    }

    @Test fun recentSessionCarriesRoleName() {
        val s = AppJson.decodeFromString<List<RecentSession>>("""[{"id":"t1","roleName":"acme-app Owner"},{"id":"t2"}]""")
        assertEquals("acme-app Owner", s[0].roleName)
        assertEquals(null, s[1].roleName)
    }
}
