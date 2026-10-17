// 扩展（外部 Vertical）入口的纯规则（对齐 android data/Verticals.kt 与 web/vertical-navigation.js，逐条配对单测）：
// - /api/system/verticals 的 navigation 是扩展 manifest 投影出来的外部输入。服务端已校验过，
//   客户端照 web 再校验一遍（纵深防御）：href 只能落在 /verticals/<verticalId>/ 之下，不带查询/片段/百分号/反斜杠/点段
// - 内嵌 WebView 只走与服务器同源的导航；别的 http(s) 交系统浏览器，其余 scheme 一律拦下
// - 页面鉴权：远程模式下页面内的 fetch 只能靠 cookie（WebView 不会给子请求带 Bearer）。服务端认的 cookie 是
//   `ownward_token=<api token>`（src/server.ts：浏览器首访令牌页验证后下发的就是它），这里在加载前直接写进
//   WebView 的 cookie 库，属性照抄服务端（Path=/、HttpOnly、SameSite=Strict、https 时 Secure），不设过期（会话 cookie，
//   每次打开页面前按当前 token 重写一遍）。令牌绝不进 URL（?token= 那条是给人手输令牌的网页引导用的，会进历史/日志）
import Foundation

/// 侧边栏「扩展」里的一项（服务端 ExternalVerticalNavigationItem）
struct VerticalNavItem: Hashable, Sendable, Identifiable {
    let verticalId: String
    let entryId: String
    let label: String
    let href: String
    let degraded: Bool

    /// 同一个扩展的入口 id 只在扩展内唯一，拼上扩展 id 才全局唯一（也是侧边栏高亮的当前页键）
    var id: String { "\(verticalId):\(entryId)" }
}

/// 扩展 id 与入口 id 同一套规则（服务端 src/verticals.ts）
private func isVerticalId(_ s: String) -> Bool { s.wholeMatch(of: /[a-z][a-z0-9-]{0,63}/) != nil }

private func hasControlChar(_ s: String) -> Bool {
    s.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7F }
}

/// 扩展静态页地址：必须在 /verticals/<verticalId>/ 命名空间里；不合格返回 nil
func safeVerticalHref(verticalId: String, _ value: String) -> String? {
    guard isVerticalId(verticalId),
          value.count <= 512, !value.contains("%"), !value.contains("\\"), !value.contains("?"), !value.contains("#"),
          !hasControlChar(value) else { return nil }
    let prefix = "/verticals/\(verticalId)/"
    guard value.hasPrefix(prefix) else { return nil }
    let suffix = String(value.dropFirst(prefix.count))
    guard !suffix.isEmpty, suffix.wholeMatch(of: /[A-Za-z0-9._~\/-]+/) != nil else { return nil }
    // split 默认丢空段，必须保留空段才能挡住 a//b 与结尾斜杠
    let parts = suffix.split(separator: "/", omittingEmptySubsequences: false)
    guard !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return nil }
    // 与服务端 / web 同一道回旋：交给 URL 解析一遍，路径原样回来、没长出查询和片段才算数
    guard let probe = URL(string: "http://ownward.invalid"), let parsed = URL(string: value, relativeTo: probe)?.absoluteURL,
          parsed.host(percentEncoded: false) == "ownward.invalid", parsed.path(percentEncoded: true) == value,
          parsed.query == nil, parsed.fragment == nil else { return nil }
    return value
}

/// navigation 原始数组 → 可展示的入口。坏项逐条丢弃，不连累其他项；同一入口 / 同一 href 只留第一条
func normalizeVerticalNavigation(_ value: [JSONValue]) -> [VerticalNavItem] {
    var seenEntries = Set<String>(), seenHrefs = Set<String>(), out: [VerticalNavItem] = []
    for raw in value {
        guard case .object(let o) = raw,
              case .string(let verticalId)? = o["verticalId"],
              case .string(let entryId)? = o["id"],
              case .string(let rawLabel)? = o["label"],
              case .string(let rawHref)? = o["href"],
              case .string(let state)? = o["state"] else { continue }
        let label = rawLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = "\(verticalId):\(entryId)"
        guard isVerticalId(verticalId), isVerticalId(entryId),
              !label.isEmpty, label.count <= 80, !hasControlChar(label),
              let href = safeVerticalHref(verticalId: verticalId, rawHref),
              state == "ready" || state == "degraded",
              !seenEntries.contains(key), !seenHrefs.contains(href) else { continue }
        seenEntries.insert(key); seenHrefs.insert(href)
        out.append(VerticalNavItem(verticalId: verticalId, entryId: entryId, label: label, href: href, degraded: state == "degraded"))
    }
    return out
}

/// 同源：scheme + host + 端口（缺省端口按 scheme 补齐）。只认 http(s)
func isSameOrigin(_ url: URL, _ base: URL) -> Bool {
    func origin(_ u: URL) -> (String, String, Int)? {
        guard let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = u.host(percentEncoded: false)?.lowercased(), !host.isEmpty else { return nil }
        return (scheme, host, u.port ?? (scheme == "https" ? 443 : 80))
    }
    guard let a = origin(url), let b = origin(base) else { return false }
    return a == b
}

/// 服务器地址 + 入口 href → 页面 URL；拼出来跑出服务器同源就不给
func verticalPageURL(base rawBase: String, href: String) -> URL? {
    let base = rawBase.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard href.hasPrefix("/"), let baseURL = URL(string: base), let url = URL(string: base + href),
          isSameOrigin(url, baseURL) else { return nil }
    return url
}

enum WebNavDecision: Equatable, Sendable {
    case allow
    case external(URL)
    case block
}

/// WebView 每次导航的去向。topLevel = 主框架或新窗口（target=_blank / window.open）；
/// 子框架的跨源加载直接拦，不能让一个内嵌 iframe 把系统浏览器弹出来
func verticalNavDecision(_ url: URL?, base: URL, topLevel: Bool) -> WebNavDecision {
    guard let url else { return .block }
    if isSameOrigin(url, base) { return .allow }
    let scheme = url.scheme?.lowercased() ?? ""
    if !topLevel, scheme == "about" { return .allow }   // 空白 iframe（about:blank / about:srcdoc）不发请求
    if topLevel, scheme == "http" || scheme == "https", url.host() != nil { return .external(url) }
    return .block
}

/// 写进 WebView 的会话 cookie：空 token（本地直连免鉴权）不需要 cookie；
/// 服务端只认 [A-Za-z0-9]+ 的 cookie 值，带别的字符写进去也是白写 → unusable，让页面提示改 token
enum WebSessionCookie: Equatable, Sendable {
    case notNeeded
    case token(String)
    case unusable
}

func webSessionCookie(token: String) -> WebSessionCookie {
    let t = token.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty { return .notNeeded }
    return t.wholeMatch(of: /[A-Za-z0-9]+/) != nil ? .token(t) : .unusable
}

let webSessionCookieName = "ownward_token"

/// 主框架响应的状态码 → 给人看的一句话；nil = 正常显示页面
func verticalHTTPFailure(status: Int) -> String? {
    switch status {
    case 200..<400: nil
    case 401: tr("未登录或 token 无效：到设置里检查服务器 token", "Not signed in or token is invalid. Check the server token in Settings.")
    case 403: tr("服务器拒绝访问这个页面", "The server refused access to this page.")
    case 404: tr("扩展页面不存在：扩展可能已停用或被移除", "Extension page not found. The extension may be disabled or removed.")
    case 429: tr("尝试次数过多，10 分钟后再试", "Too many attempts. Try again in 10 minutes.")
    default: tr("扩展页面加载失败（HTTP \(status)）", "Failed to load the extension page (HTTP \(status)).")
    }
}
