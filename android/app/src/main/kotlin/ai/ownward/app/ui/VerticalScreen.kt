package ai.ownward.app.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Undo
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import ai.ownward.app.data.ServerConfig
import ai.ownward.app.data.VerticalNavItem
import ai.ownward.app.data.WebNavDecision
import ai.ownward.app.data.WebSessionCookie
import ai.ownward.app.data.verticalHttpFailure
import ai.ownward.app.data.verticalNavDecision
import ai.ownward.app.data.verticalPageUrl
import ai.ownward.app.data.webSessionCookie
import ai.ownward.app.data.webSessionCookieHeader
import ai.ownward.app.ui.theme.ownwardColors
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

// 扩展页面（外部 Vertical 的网页）：侧边栏「扩展」点进来，用内嵌 WebView 打开 <服务器><href>
// （对齐 ios Features/Verticals/VerticalPageView.swift）。规则都在 data/Verticals.kt，这里只接线：
// - 加载前把会话 cookie 写进 CookieManager（远程模式下页面内 fetch 靠它过鉴权），令牌不进 URL
// - 只走与服务器同源的导航；别的 http(s) 链接交系统浏览器，其余 scheme 拦下
// - 主框架 401/403/404/429/5xx 盖上原生提示 + 重试（401 那页是网页版令牌输入框，不给它露脸）
// - 返回键先在网页里后退，退到头才离开本页；抽屉开着时让抽屉先关（BackHandler 的 enabled 带上抽屉态）
// - 渲染进程被系统杀掉时必须接住（不接 App 会跟着崩）：换一个新 WebView 重开

/** 「降级」小标签：扩展在跑但有子系统不健康（state=degraded），页面多半能开，部分功能可能不可用 */
@Composable
fun DegradedTag() {
    Surface(shape = CircleShape, color = ownwardColors.Warn.copy(alpha = 0.14f)) {
        Text(
            tr("降级", "Degraded"),
            style = MaterialTheme.typography.labelSmall,
            color = ownwardColors.Warn,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

private fun openExternal(context: Context, url: String) {
    runCatching {
        context.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse(url))
                .addCategory(Intent.CATEGORY_BROWSABLE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}

private suspend fun setSessionCookie(url: String, header: String): Boolean = suspendCancellableCoroutine { cont ->
    val cm = CookieManager.getInstance()
    cm.setAcceptCookie(true)
    cm.setCookie(url, header) { ok -> if (cont.isActive) cont.resume(ok) }
}

private fun webErrorMessage(code: Int): String = when (code) {
    WebViewClient.ERROR_HOST_LOOKUP, WebViewClient.ERROR_CONNECT -> tr("无法连接服务器", "Cannot reach the server.")
    WebViewClient.ERROR_TIMEOUT -> tr("连接超时", "Connection timed out.")
    WebViewClient.ERROR_FAILED_SSL_HANDSHAKE -> tr("TLS 握手失败：检查服务器证书", "TLS handshake failed. Check the server certificate.")
    else -> tr("页面加载失败（$code）", "Failed to load the page ($code).")
}

@SuppressLint("SetJavaScriptEnabled")
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VerticalScreen(config: ServerConfig, item: VerticalNavItem, onBack: () -> Unit) {
    val context = LocalContext.current
    val drawer = LocalDrawer.current
    val base = remember(config.baseUrl) { config.baseUrl.trim().trimEnd('/') }
    val pageUrl = remember(base, item.href) { verticalPageUrl(base, item.href) }

    var failure by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var progress by remember { mutableIntStateOf(0) }
    var canGoBack by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    var generation by remember { mutableIntStateOf(0) }
    var renderGone by remember { mutableStateOf(false) }

    val webView = remember(generation) {
        WebView(context).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true            // 扩展页自己的 localStorage 偏好
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.javaScriptCanOpenWindowsAutomatically = false
            settings.setSupportMultipleWindows(false)    // target=_blank / window.open 落回本窗口，走下面的导航策略
            settings.setGeolocationEnabled(false)
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    when (val d = verticalNavDecision(request.url.toString(), base, request.isForMainFrame)) {
                        WebNavDecision.Allow -> false
                        is WebNavDecision.External -> { openExternal(context, d.url); true }
                        WebNavDecision.Block -> true
                    }

                override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) { loading = true }

                override fun onPageFinished(view: WebView, url: String?) {
                    loading = false
                    canGoBack = view.canGoBack()
                }

                override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                    canGoBack = view.canGoBack()
                }

                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                    if (!request.isForMainFrame) return
                    verticalHttpFailure(errorResponse.statusCode)?.let { failure = it; view.stopLoading() }
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame && failure == null) failure = webErrorMessage(error.errorCode)
                }

                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    renderGone = true
                    failure = tr("页面进程已退出，点重试重新打开", "The page process exited. Tap Retry to reopen it.")
                    return true
                }
            }
            // 设了 WebChromeClient，alert/confirm/prompt 才会弹系统默认对话框（不设则一律静默、confirm 恒为 false）
            webChromeClient = object : WebChromeClient() {
                override fun onProgressChanged(view: WebView, newProgress: Int) { progress = newProgress }
            }
        }
    }
    DisposableEffect(webView) {
        onDispose {
            webView.stopLoading()
            webView.destroy()
        }
    }

    // 每次（重试也一样）都从入口地址重来：失败可能出在页面内的某次跳转，回到入口最可预期
    LaunchedEffect(webView, attempt) {
        failure = null
        val url = pageUrl
        if (url == null) {
            failure = tr("扩展地址无效", "Invalid extension address.")
            return@LaunchedEffect
        }
        when (val c = webSessionCookie(config.token)) {
            WebSessionCookie.NotNeeded -> Unit
            WebSessionCookie.Unusable -> {
                failure = tr("token 含服务器不认的字符，页面无法登录：到设置里重新填写", "The token contains characters the server does not accept. Re-enter it in Settings.")
                return@LaunchedEffect
            }
            is WebSessionCookie.Token -> {
                val ok = setSessionCookie(base, webSessionCookieHeader(c.value, secure = base.startsWith("https:", ignoreCase = true)))
                if (!ok) {
                    failure = tr("无法建立页面会话", "Could not set up the page session.")
                    return@LaunchedEffect
                }
            }
        }
        loading = true
        progress = 0
        webView.loadUrl(url)
    }

    fun retry() {
        if (renderGone) {
            renderGone = false
            generation++     // 换新 WebView；LaunchedEffect 跟着 webView 变化重新加载
        } else {
            attempt++
        }
    }

    BackHandler(enabled = canGoBack && failure == null && drawer?.isOpen != true) { webView.goBack() }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            item.label, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        if (item.degraded) {
                            Spacer(Modifier.width(8.dp))
                            DegradedTag()
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, tr("返回", "Back")) }
                },
                actions = {
                    if (canGoBack && failure == null) {
                        IconButton(onClick = { webView.goBack() }) {
                            Icon(Icons.AutoMirrored.Filled.Undo, tr("网页后退", "Back in page"))
                        }
                    }
                    IconButton(onClick = { retry() }) { Icon(Icons.Filled.Refresh, tr("重新加载", "Reload")) }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { padding ->
        Box(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePadding(),   // 页面里的输入框（例如扩展自带的聊天）弹键盘时 WebView 跟着缩，焦点框自己滚进视野
        ) {
            key(generation) {
                AndroidView(factory = { webView }, modifier = Modifier.fillMaxSize())
            }
            if (loading && failure == null) {
                LinearProgressIndicator(
                    progress = { (progress.coerceIn(5, 100)) / 100f },
                    modifier = Modifier.fillMaxWidth().align(Alignment.TopCenter),
                )
            }
            failure?.let { msg ->
                Column(
                    Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(32.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(Icons.Outlined.WarningAmber, null, tint = ownwardColors.Warn, modifier = Modifier.size(32.dp))
                    Spacer(Modifier.padding(top = 12.dp))
                    Text(msg, style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
                    Spacer(Modifier.padding(top = 16.dp))
                    Button(onClick = { retry() }) { Text(tr("重试", "Retry")) }
                }
            }
        }
    }
}
