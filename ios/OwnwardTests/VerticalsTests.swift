import Foundation
import Testing
@testable import Ownward

/// 与 android VerticalsTest 逐条配对；扩展名一律虚构
struct VerticalsTests {
    private func entry(_ verticalId: String, _ id: String, _ label: String, _ href: String, _ state: String = "ready") -> JSONValue {
        .object(["verticalId": .string(verticalId), "id": .string(id), "label": .string(label), "href": .string(href), "state": .string(state)])
    }

    @Test func 合法入口保留且降级照常列出() {
        let items = normalizeVerticalNavigation([
            entry("sample-ext", "home", " 示例扩展 ", "/verticals/sample-ext/index.html"),
            entry("demo-board", "board", "Demo Board", "/verticals/demo-board/app/main.html", "degraded"),
        ])
        #expect(items == [
            VerticalNavItem(verticalId: "sample-ext", entryId: "home", label: "示例扩展", href: "/verticals/sample-ext/index.html", degraded: false),
            VerticalNavItem(verticalId: "demo-board", entryId: "board", label: "Demo Board", href: "/verticals/demo-board/app/main.html", degraded: true),
        ])
        #expect(items[0].id == "sample-ext:home")
    }

    @Test func href必须落在自己的命名空间且不带查询片段与点段() {
        for bad in [
            "/verticals/other/index.html", "/verticals/sample-ext-evil/index.html", "/verticals/sample-ext/../secret.html",
            "/verticals/sample-ext/%2e%2e/secret.html", "/verticals/sample-ext/index.html?token=x", "/verticals/sample-ext/index.html#x",
            "https://example.com/verticals/sample-ext/index.html", "//example.com/verticals/sample-ext/index.html",
            "/verticals/sample-ext/", "/verticals/sample-ext//index.html", "/verticals/sample-ext/./index.html",
            "/verticals/sample-ext/a\\b.html", "/verticals/sample-ext/a b.html", "/verticals/sample-ext/index.html\n",
        ] {
            #expect(safeVerticalHref(verticalId: "sample-ext", bad) == nil, "\(bad)")
        }
        #expect(safeVerticalHref(verticalId: "sample-ext", "/verticals/sample-ext/index.html") == "/verticals/sample-ext/index.html")
        #expect(safeVerticalHref(verticalId: "Bad_Id", "/verticals/Bad_Id/index.html") == nil)
        #expect(safeVerticalHref(verticalId: "sample-ext", "/verticals/sample-ext/" + String(repeating: "a", count: 512)) == nil)
    }

    @Test func 坏项逐条丢弃且重复入口与重复href只留第一条() {
        let items = normalizeVerticalNavigation([
            .string("not-an-object"),
            entry("sample-ext", "home", "", "/verticals/sample-ext/index.html"),                         // 空标签
            entry("sample-ext", "home", String(repeating: "x", count: 81), "/verticals/sample-ext/a.html"), // 标签过长
            entry("sample-ext", "home", "bad\u{0007}", "/verticals/sample-ext/b.html"),                // 控制字符
            entry("sample-ext", "home", "ok", "/verticals/sample-ext/index.html", "stopped"),          // 不可服务
            entry("sample-ext", "Home", "ok", "/verticals/sample-ext/index.html"),                     // 入口 id 不合规
            entry("sample-ext", "home", "首页", "/verticals/sample-ext/index.html"),
            entry("sample-ext", "home", "重复入口", "/verticals/sample-ext/other.html"),
            entry("sample-ext", "other", "重复 href", "/verticals/sample-ext/index.html"),
            .object(["verticalId": .string("sample-ext"), "id": .string("x"), "label": .string("缺 href"), "state": .string("ready")]),
        ])
        #expect(items.map(\.label) == ["首页"])
    }

    @Test func 页面地址只拼同源() {
        #expect(verticalPageURL(base: "http://100.64.0.2:4517", href: "/verticals/sample-ext/index.html")?.absoluteString
                == "http://100.64.0.2:4517/verticals/sample-ext/index.html")
        #expect(verticalPageURL(base: "https://box.example.net/", href: "/verticals/sample-ext/index.html")?.absoluteString
                == "https://box.example.net/verticals/sample-ext/index.html")
        #expect(verticalPageURL(base: "http://127.0.0.1:4517", href: "verticals/sample-ext/index.html") == nil)
        // 双斜杠拼在 base 后面只是路径，不会变成别的主机
        #expect(verticalPageURL(base: "http://127.0.0.1:4517", href: "//evil.example/verticals/x/index.html")?.host() == "127.0.0.1")
        #expect(verticalPageURL(base: "http://127.0.0.1:4517", href: "@evil.example/verticals/x/index.html") == nil)
    }

    @Test func 导航只放行同源_外链交系统浏览器_其余拦下() throws {
        let base = try #require(URL(string: "http://100.64.0.2:4517"))
        let same = URL(string: "http://100.64.0.2:4517/verticals/sample-ext/index.html#symbol=X")
        #expect(verticalNavDecision(same, base: base, topLevel: true) == .allow)
        #expect(verticalNavDecision(same, base: base, topLevel: false) == .allow)
        #expect(verticalNavDecision(URL(string: "HTTP://100.64.0.2:4517/"), base: base, topLevel: true) == .allow)
        // 端口不同 / scheme 不同 都不同源
        let otherPort = try #require(URL(string: "http://100.64.0.2:4518/"))
        #expect(verticalNavDecision(otherPort, base: base, topLevel: true) == .external(otherPort))
        let https = try #require(URL(string: "https://100.64.0.2:4517/"))
        #expect(verticalNavDecision(https, base: base, topLevel: true) == .external(https))
        let news = try #require(URL(string: "https://news.example.com/a"))
        #expect(verticalNavDecision(news, base: base, topLevel: true) == .external(news))
        #expect(verticalNavDecision(news, base: base, topLevel: false) == .block)       // 子框架跨源：拦，不弹浏览器
        #expect(verticalNavDecision(URL(string: "about:blank"), base: base, topLevel: false) == .allow)
        #expect(verticalNavDecision(URL(string: "about:blank"), base: base, topLevel: true) == .block)
        for s in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "tel:10086", "mailto:a@b.c", "custom-app://x"] {
            #expect(verticalNavDecision(URL(string: s), base: base, topLevel: true) == .block, "\(s)")
        }
        #expect(verticalNavDecision(nil, base: base, topLevel: true) == .block)
        // 缺省端口按 scheme 补齐
        let httpsBase = try #require(URL(string: "https://box.example.net"))
        #expect(verticalNavDecision(URL(string: "https://box.example.net:443/verticals/a/b.html"), base: httpsBase, topLevel: true) == .allow)
    }

    @Test func 会话cookie只接受服务端认的字符() {
        #expect(webSessionCookie(token: "") == .notNeeded)
        #expect(webSessionCookie(token: "  ") == .notNeeded)
        #expect(webSessionCookie(token: " abcDEF0123 ") == .token("abcDEF0123"))
        #expect(webSessionCookie(token: "abc;def") == .unusable)
        #expect(webSessionCookie(token: "abc def") == .unusable)
        #expect(webSessionCookieName == "ownward_token")
    }

    @Test func 主框架状态码映射成提示() {
        #expect(verticalHTTPFailure(status: 200) == nil)
        #expect(verticalHTTPFailure(status: 304) == nil)
        for code in [401, 403, 404, 429, 500, 502] {
            #expect(verticalHTTPFailure(status: code) != nil, "\(code)")
        }
        #expect(verticalHTTPFailure(status: 401) != verticalHTTPFailure(status: 429))
    }

    @Test func 界面语言跟随首选语言里的中文() {
        #expect(UILang.resolve(["zh-Hans-CN"]) == .zh)
        #expect(UILang.resolve(["en-US", "zh-Hant-TW"]) == .zh)
        #expect(UILang.resolve(["en-US"]) == .en)
        #expect(UILang.resolve([]) == .en)
    }

    @Test func 抽屉键与路由键同一套() {
        let item = VerticalNavItem(verticalId: "sample-ext", entryId: "home", label: "示例", href: "/verticals/sample-ext/index.html", degraded: false)
        #expect(DrawerDest.vertical(item).key == "vertical:sample-ext:home")
    }
}
