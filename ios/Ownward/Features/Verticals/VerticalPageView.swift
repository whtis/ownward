// 扩展页面（外部 Vertical 的网页）：侧边栏「扩展」点进来，用内嵌 WKWebView 打开 <服务器><href>
// （对齐 android ui/VerticalScreen.kt）。规则都在 Core/Verticals.swift，这里只接线：
// - 加载前把会话 cookie 写进 WebView 的 cookie 库（远程模式下页面内 fetch 靠它过鉴权），令牌不进 URL
// - 只走与服务器同源的导航；别的 http(s) 链接交系统浏览器，其余 scheme 拦下
// - 主框架 401/403/404/429/5xx 不渲染服务端的页面（401 那页是网页版令牌输入框），换成原生提示 + 重试
// - 页面里的 alert/confirm/prompt 接成系统弹窗：WKWebView 默认不实现，confirm() 会静默返回 false
// - 左边缘滑动留给 NavigationStack 的返回；网页内后退走顶栏按钮
import SwiftUI
import UIKit
import WebKit

struct VerticalPageView: View {
    let client: OwnwardClient
    let item: VerticalNavItem

    @State private var model: VerticalPageModel?
    @State private var promptText = ""

    var body: some View {
        ZStack {
            OW.bg.ignoresSafeArea()
            if let model {
                WebViewHost(webView: model.webView)
                    .opacity(model.failure == nil ? 1 : 0)
                if let failure = model.failure {
                    failureView(failure) { model.retry() }
                }
            }
        }
        .overlay(alignment: .top) {
            if let model, model.loading, model.failure == nil {
                ProgressView(value: max(0.05, model.progress)).progressViewStyle(.linear).tint(OW.accent)
            }
        }
        .toolbar(.hidden, for: .tabBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { DrawerMenuButton() }
            ToolbarItem(placement: .principal) {
                HStack(spacing: 6) {
                    Text(item.label).font(.owTitleS).lineLimit(1)
                    if item.degraded { DegradedTag() }
                }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let model, model.canGoBack, model.failure == nil {
                    Button { Haptics.tap(); model.goBack() } label: { Image(systemName: "arrow.uturn.backward") }
                        .accessibilityLabel(tr("网页后退", "Back in page"))
                }
                Button { Haptics.tap(); model?.retry() } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(model == nil)
                    .accessibilityLabel(tr("重新加载", "Reload"))
            }
        }
        .alert(
            model?.dialog?.message ?? "",
            isPresented: Binding(get: { model?.dialog != nil }, set: { _ in }),   // 只由按钮收尾：每个回调必须恰好答一次
            presenting: model?.dialog
        ) { dialog in
            switch dialog.kind {
            case .alert:
                Button(tr("好", "OK")) { model?.resolveDialog(true) }
            case .confirm:
                Button(tr("取消", "Cancel"), role: .cancel) { model?.resolveDialog(false) }
                Button(tr("确定", "OK")) { model?.resolveDialog(true) }
            case .prompt:
                TextField("", text: $promptText)
                Button(tr("取消", "Cancel"), role: .cancel) { model?.resolveDialog(false) }
                Button(tr("确定", "OK")) { model?.resolveDialog(true, text: promptText) }
            }
        }
        .onChange(of: model?.dialog?.id) { _, _ in promptText = model?.dialog?.defaultText ?? "" }
        .task(id: item) {
            if model?.item != item { model = VerticalPageModel(client: client, item: item) }
            await model?.start()
        }
        .onDisappear { model?.resolveDialog(false) }
    }

    private func failureView(_ message: String, retry: @escaping () -> Void) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 30)).foregroundStyle(OW.warn)
            Text(message).listBody().foregroundStyle(OW.text).multilineTextAlignment(.center)
            Button { Haptics.tap(); retry() } label: { Text(tr("重试", "Retry")).frame(minWidth: 96) }
                .buttonStyle(.borderedProminent)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(OW.bg)
    }
}

/// 「降级」小标签：扩展在跑但有子系统不健康（state=degraded），页面多半能开，部分功能可能不可用
struct DegradedTag: View {
    var body: some View {
        Text(tr("降级", "Degraded"))
            .font(.owLabelS).foregroundStyle(OW.warn)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(OW.warn.opacity(0.14), in: Capsule())
    }
}

private struct WebViewHost: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

struct JSDialog: Identifiable, Equatable {
    enum Kind: Equatable { case alert, confirm, prompt }
    let id = UUID()
    let kind: Kind
    let message: String
    var defaultText: String? = nil
}

@MainActor @Observable
final class VerticalPageModel: NSObject, WKNavigationDelegate, WKUIDelegate {
    let item: VerticalNavItem
    var loading = false
    var progress = 0.0
    var canGoBack = false
    var failure: String?
    var dialog: JSDialog?

    @ObservationIgnored let webView: WKWebView
    @ObservationIgnored private let base: URL?
    @ObservationIgnored private let pageURL: URL?
    @ObservationIgnored private let cookie: WebSessionCookie
    @ObservationIgnored private var started = false
    @ObservationIgnored private var dialogReply: ((Bool, String?) -> Void)?
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []

    init(client: OwnwardClient, item: VerticalNavItem) {
        self.item = item
        base = URL(string: client.base)
        pageURL = verticalPageURL(base: client.base, href: item.href)
        cookie = webSessionCookie(token: client.token)
        let cfg = WKWebViewConfiguration()
        // 持久数据库：扩展页自己的 localStorage 偏好要跨次保留。令牌 cookie 不设过期（会话 cookie），
        // 每次打开页面前都按当前 token 重写，换了 token 不会沿用旧值
        cfg.websiteDataStore = .default()
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
        cfg.dataDetectorTypes = []
        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.allowsBackForwardNavigationGestures = false   // 左边缘是 NavigationStack 滑动返回的地盘
        wv.isOpaque = false
        wv.backgroundColor = .clear
        #if DEBUG
        wv.isInspectable = true
        #endif
        webView = wv
        super.init()
        wv.navigationDelegate = self
        wv.uiDelegate = self
        observations = [
            wv.observe(\.canGoBack, options: [.new]) { [weak self] wv, _ in
                MainActor.assumeIsolated { self?.canGoBack = wv.canGoBack }
            },
            wv.observe(\.isLoading, options: [.new]) { [weak self] wv, _ in
                MainActor.assumeIsolated { self?.loading = wv.isLoading }
            },
            wv.observe(\.estimatedProgress, options: [.new]) { [weak self] wv, _ in
                MainActor.assumeIsolated { self?.progress = wv.estimatedProgress }
            },
        ]
    }

    /// 首次出现才加载；task 重跑（返回本页）不重复加载
    func start() async {
        guard !started else { return }
        started = true
        await load()
    }

    func retry() { Task { await load() } }

    func goBack() { if webView.canGoBack { webView.goBack() } }

    /// 每次都从入口地址重来：失败可能出在页面内的某次跳转，回到入口最可预期
    private func load() async {
        failure = nil
        guard let base, let pageURL else {
            failure = tr("扩展地址无效", "Invalid extension address.")
            return
        }
        switch cookie {
        case .notNeeded:
            break
        case .unusable:
            failure = tr("token 含服务器不认的字符，页面无法登录：到设置里重新填写", "The token contains characters the server does not accept. Re-enter it in Settings.")
            return
        case .token(let value):
            var props: [HTTPCookiePropertyKey: Any] = [
                .name: webSessionCookieName, .value: value, .path: "/", .originURL: base,
                HTTPCookiePropertyKey("HttpOnly"): "TRUE",
                .sameSitePolicy: HTTPCookieStringPolicy.sameSiteStrict,
            ]
            if base.scheme?.lowercased() == "https" { props[.secure] = "TRUE" }
            guard let c = HTTPCookie(properties: props) else {
                failure = tr("无法建立页面会话", "Could not set up the page session.")
                return
            }
            await webView.configuration.websiteDataStore.httpCookieStore.setCookie(c)
        }
        loading = true
        webView.load(URLRequest(url: pageURL))
    }

    // MARK: - 导航策略

    private func route(_ request: URLRequest, topLevel: Bool) -> WebNavDecision {
        guard let base else { return .block }
        return verticalNavDecision(request.url, base: base, topLevel: topLevel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let newWindow = navigationAction.targetFrame == nil
        let topLevel = newWindow || navigationAction.targetFrame?.isMainFrame == true
        switch route(navigationAction.request, topLevel: topLevel) {
        case .allow:
            if newWindow {
                // target=_blank 的同源链接：就地打开，不开新窗口
                decisionHandler(.cancel)
                webView.load(navigationAction.request)
            } else {
                decisionHandler(.allow)
            }
        case .external(let url):
            decisionHandler(.cancel)
            UIApplication.shared.open(url)
        case .block:
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, let http = navigationResponse.response as? HTTPURLResponse,
           let message = verticalHTTPFailure(status: http.statusCode) {
            failure = message
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        fail(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        fail(error)
    }

    private func fail(_ error: any Error) {
        let ns = error as NSError
        // 主动取消（新导航顶掉旧的）与「策略改判」（上面 cancel 了响应）都不是加载失败
        if ns.domain == NSURLErrorDomain, ns.code == NSURLErrorCancelled { return }
        if ns.domain == "WebKitErrorDomain", ns.code == 102 { return }
        if failure == nil { failure = error.userMessage }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()   // 内容进程被系统回收（内存压力）：白屏比重载更糟
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // window.open：同源就地打开，外链交系统浏览器；永远不开第二个 WebView
        switch route(navigationAction.request, topLevel: true) {
        case .allow: webView.load(navigationAction.request)
        case .external(let url): UIApplication.shared.open(url)
        case .block: break
        }
        return nil
    }

    // MARK: - JS 弹窗

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor @Sendable () -> Void) {
        present(JSDialog(kind: .alert, message: message)) { _, _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) {
        present(JSDialog(kind: .confirm, message: message)) { ok, _ in completionHandler(ok) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (String?) -> Void) {
        present(JSDialog(kind: .prompt, message: prompt, defaultText: defaultText)) { ok, text in completionHandler(ok ? (text ?? "") : nil) }
    }

    private func present(_ next: JSDialog, reply: @escaping (Bool, String?) -> Void) {
        resolveDialog(false)   // 理论上不会叠两个；真叠了先把旧的按取消答掉，WebKit 要求每个回调恰好调用一次
        dialogReply = reply
        dialog = next
    }

    /// 按钮收尾 / 页面离开时兜底（离开时按取消答复，回调不能悬空）
    func resolveDialog(_ ok: Bool, text: String? = nil) {
        let reply = dialogReply
        dialogReply = nil
        dialog = nil
        reply?(ok, text)
    }
}
