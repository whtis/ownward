package ai.ownward.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.ownward.app.data.DevMsg
import ai.ownward.app.data.ObservedSession
import ai.ownward.app.data.OwnwardClient
import ai.ownward.app.ui.theme.ownwardColors
import kotlinx.coroutines.launch

/**
 * 旁观 + 接管（对齐 web/tasks.js 的 pollCcObserve / adoptCc / adoptTerminal）。
 * 两种入口：
 *  - 外部会话（ccId）：本机 Terminal/clawd 跑的 Claude 或 Codex 会话，只读增量跟读；「接管续聊」= 签凭证 → 接管成 ownward 任务
 *  - terminal 任务（taskId）：ownward 派到 Terminal 窗口的任务，底层 Claude 会话 id 由服务端认领；「接管到引擎」一步到位
 * 接管成功后 onAdopted(新任务 id)，调用方直接跳会话页续聊。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ObserveScreen(
    client: OwnwardClient,
    ccId: String?,
    taskId: String?,
    onBack: () -> Unit,
    onAdopted: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val listState = rememberLazyListState()
    var sessionId by remember { mutableStateOf(ccId?.takeIf { it.isNotBlank() }) }
    var meta by remember { mutableStateOf<ObservedSession?>(null) }
    var msgs by remember { mutableStateOf<List<DevMsg>>(emptyList()) }
    var offset by remember { mutableStateOf(0L) }
    var truncated by remember { mutableStateOf(false) }
    var grewLast by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var adopting by remember { mutableStateOf(false) }
    var loaded by remember { mutableStateOf(false) }
    val isTerminal = !taskId.isNullOrBlank()

    // 会话元数据（项目名/标题/是否活跃）是慢数据，60s 一轮；列表里找不到（掉出窗口）也不影响跟读
    Poller(key = "observe-meta-$ccId-$taskId") {
        sessionId?.let { id ->
            runCatching { client.ccSessions().find { it.id == id } }.getOrNull()?.let { meta = it }
        }
        60_000L
    }

    // 消息增量跟读：活跃会话 2.5s，空闲 8s（web 同款 cadence）
    Poller(key = "observe-$ccId-$taskId") {
        try {
            // terminal 任务的底层会话以服务端认领为准：列表里带来的 ccSessionId 只是初值，
            // 还没认领到 / 上一轮读失败（链接失效被服务端重认）时都向服务端重问，id 变了就从头读
            if (isTerminal && (sessionId == null || error != null)) {
                val r = client.taskCcSession(taskId!!)
                if (r.ok && !r.sessionId.isNullOrBlank() && r.sessionId != sessionId) {
                    sessionId = r.sessionId
                    offset = 0L; msgs = emptyList(); truncated = false
                }
            }
            sessionId?.let { id ->
                val page = client.ccSession(id, offset)
                if (!page.ok && page.messages.isEmpty()) {
                    error = page.msg.ifBlank { "会话读取失败" }
                } else {
                    // 首帧 / 文件缩小（offset 回退）= 截断重建：清空累积再并
                    if (offset == 0L || page.offset < offset) {
                        msgs = page.messages
                        truncated = page.truncated
                    } else if (page.messages.isNotEmpty()) {
                        msgs = msgs + page.messages
                    }
                    grewLast = page.messages.isNotEmpty()
                    offset = page.offset
                    error = null
                }
            }
            loaded = true
        } catch (e: Exception) {
            error = e.message
        }
        if (meta?.active == true || grewLast) 2500L else 8000L
    }

    // 列表 reverseLayout 锚定底部（index 0 = 最新）：进会话直接落在最后一条；贴近底部才自动跟随，上翻不抢滚动位置
    // （之前按 layoutInfo.totalItemsCount 算目标：effect 跑在布局之前，首帧时 total 还是 0，从不滚动）
    LaunchedEffect(msgs.size) {
        if (listState.firstVisibleItemIndex <= 2) listState.scrollToItem(0)
    }

    fun adopt() {
        if (adopting) return
        adopting = true
        scope.launch {
            try {
                val r = if (isTerminal) {
                    client.adoptTerminal(taskId!!)
                } else {
                    val id = sessionId ?: error("会话还没就绪")
                    val cap = client.ccAdoptCapability(id)
                    val token = cap.adoptToken
                    if (!cap.ok || token.isNullOrBlank()) error(cap.msg.ifBlank { "无法签发接管凭证" })
                    client.ccAdopt(id, token)
                }
                if (!r.ok) {
                    error = r.msg
                } else {
                    val newId = r.taskId()
                    if (newId != null) onAdopted(newId) else error = r.msg.ifBlank { "已接管，但没拿到新会话 id" }
                }
            } catch (e: Exception) {
                error = e.message
            } finally {
                adopting = false
            }
        }
    }

    val engineLabel = if (meta?.isCodex == true) "codex" else "claude"
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            Column(Modifier.glassBar()) {
                CenterAlignedTopAppBar(
                    title = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            StatusDot(
                                if (meta?.active == true) ownwardColors.Success
                                else MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Spacer(Modifier.width(8.dp))
                            // 项目名可能是超长 hash 目录名（cwd 缺失时的服务端回落），单行省略
                            Text(
                                (meta?.project?.ifBlank { null } ?: if (isTerminal) "terminal" else "会话") +
                                    " · $engineLabel · 旁观",
                                style = MaterialTheme.typography.titleSmall,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    },
                    navigationIcon = { DrawerOrBackButton(onBack) },
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = Color.Transparent),
                )
                meta?.title?.takeIf { it.isNotBlank() }?.let {
                    Text(
                        it, style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp),
                    )
                }
                ErrorBanner(error)
            }
        },
        bottomBar = {
            Column(
                Modifier
                    .fillMaxWidth()
                    .glassBar()
                    .navigationBarsPadding()
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            ) {
                Text(
                    when {
                        meta?.active == true -> "会话正被其他端驱动（2 分钟内有写入），空闲后才能接管"
                        isTerminal -> "接管后 Terminal 任务收尾，会话转由 ownward 引擎续聊（Terminal 里的会话须已空闲）"
                        else -> "接管后变成 ownward 会话，可在手机上直接续聊、审批"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = if (meta?.active == true) ownwardColors.Warn else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 8.dp),
                )
                Button(
                    onClick = ::adopt,
                    enabled = !adopting && (sessionId != null || isTerminal),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (adopting) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        Spacer(Modifier.width(8.dp))
                        Text("正在接管…")
                    } else {
                        Text(if (isTerminal) "接管到引擎" else "接管续聊")
                    }
                }
            }
        },
    ) { padding ->
        LazyColumn(
            state = listState,
            reverseLayout = true,
            // reverseLayout 默认把不满一屏的内容堆在底部；Top 保持短会话顶对齐，只有滚动起点变成底部
            verticalArrangement = Arrangement.Top,
            modifier = Modifier.fillMaxSize().hazeContent(),
            contentPadding = PaddingValues(
                top = padding.calculateTopPadding() + 8.dp,
                bottom = padding.calculateBottomPadding() + 8.dp,
            ),
        ) {
            // reverseLayout：先写的在底部——消息倒序、截断提示写在最后（视觉上在顶部）；key 用正序下标，增量追加时旧项不换位
            // 连续工具调用折成一组（foldToolRuns，和任务会话同一套）：旁观的是别人正在跑的会话，
            // 工具流只会更长。这里没有 turn 状态可判，一律按「已执行」收起。
            val feed = foldToolRuns(msgs)
            items(feed.size, key = { feed[feed.size - 1 - it].index }) { i ->
                FeedRow(feed[feed.size - 1 - i], live = false, client = client)
            }
            if (truncated) {
                item(key = "truncated") {
                    Text(
                        "（长会话已截断前文）",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                    )
                }
            }
            if (msgs.isEmpty()) {
                item(key = "empty") {
                    Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                        Text(
                            when {
                                !loaded -> "正在载入会话…"
                                sessionId == null && isTerminal -> "terminal 任务在 Terminal 窗口里跑，还没认领到底层 Claude 会话（稍等）"
                                else -> "会话暂无内容"
                            },
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}
