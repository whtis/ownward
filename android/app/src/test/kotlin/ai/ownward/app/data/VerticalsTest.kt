package ai.ownward.app.data

import ai.ownward.app.ui.DrawerDest
import ai.ownward.app.ui.UiLang
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** 与 ios VerticalsTests 逐条配对；扩展名一律虚构 */
class VerticalsTest {
    private fun entry(verticalId: String, id: String, label: String, href: String, state: String = "ready") = buildJsonObject {
        put("verticalId", verticalId); put("id", id); put("label", label); put("href", href); put("state", state)
    }

    @Test fun keepsValidEntriesAndListsDegradedOnes() {
        val items = normalizeVerticalNavigation(JsonArray(listOf(
            entry("sample-ext", "home", " 示例扩展 ", "/verticals/sample-ext/index.html"),
            entry("demo-board", "board", "Demo Board", "/verticals/demo-board/app/main.html", "degraded"),
        )))
        assertEquals(listOf(
            VerticalNavItem("sample-ext", "home", "示例扩展", "/verticals/sample-ext/index.html", false),
            VerticalNavItem("demo-board", "board", "Demo Board", "/verticals/demo-board/app/main.html", true),
        ), items)
        assertEquals("sample-ext:home", items[0].id)
    }

    @Test fun hrefMustStayInOwnNamespaceWithoutQueryFragmentOrDotSegments() {
        for (bad in listOf(
            "/verticals/other/index.html", "/verticals/sample-ext-evil/index.html", "/verticals/sample-ext/../secret.html",
            "/verticals/sample-ext/%2e%2e/secret.html", "/verticals/sample-ext/index.html?token=x", "/verticals/sample-ext/index.html#x",
            "https://example.com/verticals/sample-ext/index.html", "//example.com/verticals/sample-ext/index.html",
            "/verticals/sample-ext/", "/verticals/sample-ext//index.html", "/verticals/sample-ext/./index.html",
            "/verticals/sample-ext/a\\b.html", "/verticals/sample-ext/a b.html", "/verticals/sample-ext/index.html\n",
        )) assertNull(bad, safeVerticalHref("sample-ext", bad))
        assertEquals("/verticals/sample-ext/index.html", safeVerticalHref("sample-ext", "/verticals/sample-ext/index.html"))
        assertNull(safeVerticalHref("Bad_Id", "/verticals/Bad_Id/index.html"))
        assertNull(safeVerticalHref("sample-ext", "/verticals/sample-ext/" + "a".repeat(512)))
    }

    @Test fun dropsBadItemsOneByOneAndKeepsFirstOfDuplicateEntryOrHref() {
        val items = normalizeVerticalNavigation(buildJsonArray {
            add(JsonPrimitive("not-an-object"))
            add(entry("sample-ext", "home", "", "/verticals/sample-ext/index.html"))                 // 空标签
            add(entry("sample-ext", "home", "x".repeat(81), "/verticals/sample-ext/a.html"))         // 标签过长
            add(entry("sample-ext", "home", "bad\u0007", "/verticals/sample-ext/b.html"))           // 控制字符
            add(entry("sample-ext", "home", "ok", "/verticals/sample-ext/index.html", "stopped"))   // 不可服务
            add(entry("sample-ext", "Home", "ok", "/verticals/sample-ext/index.html"))              // 入口 id 不合规
            add(entry("sample-ext", "home", "首页", "/verticals/sample-ext/index.html"))
            add(entry("sample-ext", "home", "重复入口", "/verticals/sample-ext/other.html"))
            add(entry("sample-ext", "other", "重复 href", "/verticals/sample-ext/index.html"))
            add(buildJsonObject { put("verticalId", "sample-ext"); put("id", "x"); put("label", "缺 href"); put("state", "ready") })
        })
        assertEquals(listOf("首页"), items.map { it.label })
        assertEquals(emptyList<VerticalNavItem>(), normalizeVerticalNavigation(null))
        assertEquals(emptyList<VerticalNavItem>(), normalizeVerticalNavigation(JsonPrimitive("nope")))
    }

    @Test fun pageUrlOnlyJoinsSameOrigin() {
        assertEquals("http://100.64.0.2:4517/verticals/sample-ext/index.html", verticalPageUrl("http://100.64.0.2:4517", "/verticals/sample-ext/index.html"))
        assertEquals("https://box.example.net/verticals/sample-ext/index.html", verticalPageUrl("https://box.example.net/", "/verticals/sample-ext/index.html"))
        assertNull(verticalPageUrl("http://127.0.0.1:4517", "verticals/sample-ext/index.html"))
        assertNull(verticalPageUrl("http://127.0.0.1:4517", "@evil.example/verticals/x/index.html"))
        // 双斜杠拼在 base 后面只是路径，不会变成别的主机
        assertEquals("127.0.0.1", java.net.URI(verticalPageUrl("http://127.0.0.1:4517", "//evil.example/verticals/x/index.html")!!).host)
    }

    @Test fun navigationAllowsSameOriginSendsLinksToBrowserBlocksTheRest() {
        val base = "http://100.64.0.2:4517"
        val same = "http://100.64.0.2:4517/verticals/sample-ext/index.html#symbol=X"
        assertEquals(WebNavDecision.Allow, verticalNavDecision(same, base, topLevel = true))
        assertEquals(WebNavDecision.Allow, verticalNavDecision(same, base, topLevel = false))
        assertEquals(WebNavDecision.Allow, verticalNavDecision("HTTP://100.64.0.2:4517/", base, topLevel = true))
        // 端口不同 / scheme 不同 都不同源
        assertEquals(WebNavDecision.External("http://100.64.0.2:4518/"), verticalNavDecision("http://100.64.0.2:4518/", base, topLevel = true))
        assertEquals(WebNavDecision.External("https://100.64.0.2:4517/"), verticalNavDecision("https://100.64.0.2:4517/", base, topLevel = true))
        val news = "https://news.example.com/a"
        assertEquals(WebNavDecision.External(news), verticalNavDecision(news, base, topLevel = true))
        assertEquals(WebNavDecision.Block, verticalNavDecision(news, base, topLevel = false))   // 子框架跨源：拦，不弹浏览器
        assertEquals(WebNavDecision.Allow, verticalNavDecision("about:blank", base, topLevel = false))
        assertEquals(WebNavDecision.Block, verticalNavDecision("about:blank", base, topLevel = true))
        for (s in listOf("javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "tel:10086", "mailto:a@b.c", "custom-app://x")) {
            assertEquals(s, WebNavDecision.Block, verticalNavDecision(s, base, topLevel = true))
        }
        assertEquals(WebNavDecision.Block, verticalNavDecision(null, base, topLevel = true))
        // 缺省端口按 scheme 补齐
        assertEquals(WebNavDecision.Allow, verticalNavDecision("https://box.example.net:443/verticals/a/b.html", "https://box.example.net", topLevel = true))
    }

    @Test fun sessionCookieOnlyAcceptsCharactersTheServerMatches() {
        assertEquals(WebSessionCookie.NotNeeded, webSessionCookie(""))
        assertEquals(WebSessionCookie.NotNeeded, webSessionCookie("  "))
        assertEquals(WebSessionCookie.Token("abcDEF0123"), webSessionCookie(" abcDEF0123 "))
        assertEquals(WebSessionCookie.Unusable, webSessionCookie("abc;def"))
        assertEquals(WebSessionCookie.Unusable, webSessionCookie("abc def"))
        assertEquals("ownward_token", WEB_SESSION_COOKIE_NAME)
        // 属性照抄服务端；不带 Expires / Max-Age（会话 cookie，不落盘）
        assertEquals("ownward_token=abc123; Path=/; HttpOnly; SameSite=Strict", webSessionCookieHeader("abc123", secure = false))
        assertEquals("ownward_token=abc123; Path=/; HttpOnly; SameSite=Strict; Secure", webSessionCookieHeader("abc123", secure = true))
    }

    @Test fun mainFrameStatusMapsToMessage() {
        assertNull(verticalHttpFailure(200))
        assertNull(verticalHttpFailure(304))
        for (code in listOf(401, 403, 404, 429, 500, 502)) assertNotNull("$code", verticalHttpFailure(code))
        assertNotEquals(verticalHttpFailure(401), verticalHttpFailure(429))
    }

    @Test fun uiLangFollowsAnyChineseInPreferredLanguages() {
        assertEquals(UiLang.ZH, UiLang.resolve(listOf("zh-Hans-CN")))
        assertEquals(UiLang.ZH, UiLang.resolve(listOf("en-US", "zh-Hant-TW")))
        assertEquals(UiLang.EN, UiLang.resolve(listOf("en-US")))
        assertEquals(UiLang.EN, UiLang.resolve(emptyList()))
    }

    @Test fun drawerKeyMatchesRouteKey() {
        val item = VerticalNavItem("sample-ext", "home", "示例", "/verticals/sample-ext/index.html", false)
        assertEquals("vertical:sample-ext:home", DrawerDest.Vertical(item).key())
    }
}
