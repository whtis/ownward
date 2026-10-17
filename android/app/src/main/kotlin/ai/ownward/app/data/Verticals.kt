package ai.ownward.app.data

import ai.ownward.app.ui.tr
import java.net.URI
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// 扩展（外部 Vertical）入口的纯规则（对齐 ios Core/Verticals.swift 与 web/vertical-navigation.js，逐条配对单测）：
// - /api/system/verticals 的 navigation 是扩展 manifest 投影出来的外部输入。服务端已校验过，
//   客户端照 web 再校验一遍（纵深防御）：href 只能落在 /verticals/<verticalId>/ 之下，不带查询/片段/百分号/反斜杠/点段
// - 内嵌 WebView 只走与服务器同源的导航；别的 http(s) 交系统浏览器，其余 scheme 一律拦下
// - 页面鉴权：远程模式下页面内的 fetch 只能靠 cookie（WebView 不会给子请求带 Bearer）。服务端认的 cookie 是
//   `ownward_token=<api token>`（src/server.ts：浏览器首访令牌页验证后下发的就是它），这里在加载前直接写进
//   WebView 的 CookieManager，属性照抄服务端（Path=/、HttpOnly、SameSite=Strict、https 时 Secure），不设过期（会话 cookie，
//   每次打开页面前按当前 token 重写一遍）。令牌绝不进 URL（?token= 那条是给人手输令牌的网页引导用的，会进历史/日志）
// 纯 JVM 可测：只用 java.net.URI，不碰 android.net.Uri

/** 侧边栏「扩展」里的一项（服务端 ExternalVerticalNavigationItem） */
data class VerticalNavItem(
    val verticalId: String,
    val entryId: String,
    val label: String,
    val href: String,
    val degraded: Boolean,
) {
    /** 同一个扩展的入口 id 只在扩展内唯一，拼上扩展 id 才全局唯一（也是侧边栏高亮的当前页键） */
    val id: String get() = "$verticalId:$entryId"
}

private val VERTICAL_ID = Regex("[a-z][a-z0-9-]{0,63}")
private val HREF_SUFFIX = Regex("[A-Za-z0-9._~/-]+")
private val CONTROL = Regex("[\\u0000-\\u001f\\u007f]")

/** 扩展静态页地址：必须在 /verticals/<verticalId>/ 命名空间里；不合格返回 null */
fun safeVerticalHref(verticalId: String, value: String): String? {
    if (!VERTICAL_ID.matches(verticalId) || value.length > 512 || value.contains('%') || value.contains('\\') ||
        value.contains('?') || value.contains('#') || CONTROL.containsMatchIn(value)) return null
    val prefix = "/verticals/$verticalId/"
    if (!value.startsWith(prefix)) return null
    val suffix = value.substring(prefix.length)
    if (suffix.isEmpty() || !HREF_SUFFIX.matches(suffix)) return null
    if (suffix.split('/').any { it.isEmpty() || it == "." || it == ".." }) return null
    // 与服务端 / web 同一道回旋：交给 URI 解析一遍，路径原样回来、没长出查询和片段才算数
    val parsed = runCatching { URI("http://ownward.invalid").resolve(value) }.getOrNull() ?: return null
    if (parsed.host != "ownward.invalid" || parsed.rawPath != value || parsed.rawQuery != null || parsed.rawFragment != null) return null
    return value
}

/** navigation 原始数组 → 可展示的入口。坏项逐条丢弃，不连累其他项；同一入口 / 同一 href 只留第一条 */
fun normalizeVerticalNavigation(value: JsonElement?): List<VerticalNavItem> {
    val arr = value as? JsonArray ?: return emptyList()
    val seenEntries = HashSet<String>()
    val seenHrefs = HashSet<String>()
    val out = ArrayList<VerticalNavItem>()
    for (raw in arr) {
        val o = raw as? JsonObject ?: continue
        fun str(key: String): String? = (o[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val verticalId = str("verticalId") ?: continue
        val entryId = str("id") ?: continue
        val label = str("label")?.trim() ?: continue
        val href = str("href")?.let { safeVerticalHref(verticalId, it) } ?: continue
        val state = str("state") ?: continue
        val key = "$verticalId:$entryId"
        if (!VERTICAL_ID.matches(verticalId) || !VERTICAL_ID.matches(entryId) || label.isEmpty() || label.length > 80 ||
            CONTROL.containsMatchIn(label) || (state != "ready" && state != "degraded") ||
            key in seenEntries || href in seenHrefs) continue
        seenEntries += key
        seenHrefs += href
        out += VerticalNavItem(verticalId, entryId, label, href, state == "degraded")
    }
    return out
}

private data class Origin(val scheme: String, val host: String, val port: Int)

private fun originOf(url: String): Origin? = runCatching {
    val u = URI(url)
    val scheme = u.scheme?.lowercase()
    val host = u.host?.lowercase()
    if ((scheme != "http" && scheme != "https") || host.isNullOrEmpty()) null
    else Origin(scheme, host, if (u.port == -1) (if (scheme == "https") 443 else 80) else u.port)
}.getOrNull()

/** 同源：scheme + host + 端口（缺省端口按 scheme 补齐）。只认 http(s) */
fun isSameOrigin(url: String, base: String): Boolean {
    val a = originOf(url) ?: return false
    return a == originOf(base)
}

/** 服务器地址 + 入口 href → 页面 URL；拼出来跑出服务器同源就不给 */
fun verticalPageUrl(base: String, href: String): String? {
    val b = base.trim().trimEnd('/')
    if (!href.startsWith("/")) return null
    val url = b + href
    return if (isSameOrigin(url, b)) url else null
}

sealed class WebNavDecision {
    data object Allow : WebNavDecision()
    data class External(val url: String) : WebNavDecision()
    data object Block : WebNavDecision()
}

/**
 * WebView 每次导航的去向。topLevel = 主框架（target=_blank / window.open 在单窗口模式下也落主框架）；
 * 子框架的跨源加载直接拦，不能让一个内嵌 iframe 把系统浏览器弹出来
 */
fun verticalNavDecision(url: String?, base: String, topLevel: Boolean): WebNavDecision {
    if (url == null) return WebNavDecision.Block
    if (isSameOrigin(url, base)) return WebNavDecision.Allow
    val scheme = runCatching { URI(url).scheme?.lowercase() }.getOrNull() ?: url.substringBefore(':', "").lowercase()
    if (!topLevel && scheme == "about") return WebNavDecision.Allow   // 空白 iframe（about:blank / about:srcdoc）不发请求
    if (topLevel && (scheme == "http" || scheme == "https") && originOf(url) != null) return WebNavDecision.External(url)
    return WebNavDecision.Block
}

/** 写进 WebView 的会话 cookie：空 token（本地直连免鉴权）不需要；服务端只认 [A-Za-z0-9]+，别的字符写进去也是白写 */
sealed class WebSessionCookie {
    data object NotNeeded : WebSessionCookie()
    data class Token(val value: String) : WebSessionCookie()
    data object Unusable : WebSessionCookie()
}

const val WEB_SESSION_COOKIE_NAME = "ownward_token"

fun webSessionCookie(token: String): WebSessionCookie {
    val t = token.trim()
    if (t.isEmpty()) return WebSessionCookie.NotNeeded
    return if (Regex("[A-Za-z0-9]+").matches(t)) WebSessionCookie.Token(t) else WebSessionCookie.Unusable
}

/** CookieManager.setCookie 要的 Set-Cookie 串：不带 Expires/Max-Age = 会话 cookie */
fun webSessionCookieHeader(value: String, secure: Boolean): String =
    "$WEB_SESSION_COOKIE_NAME=$value; Path=/; HttpOnly; SameSite=Strict" + if (secure) "; Secure" else ""

/** 主框架响应的状态码 → 给人看的一句话；null = 正常显示页面 */
fun verticalHttpFailure(status: Int): String? = when {
    status in 200..399 -> null
    status == 401 -> tr("未登录或 token 无效：到设置里检查服务器 token", "Not signed in or token is invalid. Check the server token in Settings.")
    status == 403 -> tr("服务器拒绝访问这个页面", "The server refused access to this page.")
    status == 404 -> tr("扩展页面不存在：扩展可能已停用或被移除", "Extension page not found. The extension may be disabled or removed.")
    status == 429 -> tr("尝试次数过多，10 分钟后再试", "Too many attempts. Try again in 10 minutes.")
    else -> tr("扩展页面加载失败（HTTP $status）", "Failed to load the extension page (HTTP $status).")
}
