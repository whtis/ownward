package ai.ownward.app.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import ai.ownward.app.data.AgentState
import ai.ownward.app.data.OwnwardClient
import ai.ownward.app.data.ImageEncoder
import ai.ownward.app.data.OutImage
import ai.ownward.app.ui.theme.ownwardColors
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskDetailScreen(client: OwnwardClient, taskId: String, onBack: () -> Unit) {
    var state by remember { mutableStateOf<AgentState?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var submitted by remember { mutableStateOf(setOf<String>()) }
    var showInfo by remember { mutableStateOf(false) }
    var input by remember { mutableStateOf("") }
    var pendingImages by remember { mutableStateOf<List<Pair<Uri, OutImage>>>(emptyList()) }
    var sending by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val listState = rememberLazyListState()
    val snackbar = remember { SnackbarHostState() }

    suspend fun refresh() {
        try {
            val next = client.devMessages(taskId)
            if (next != state) state = next
            error = null
        } catch (e: Exception) {
            error = e.message
        }
    }

    // 运行中 2.5s，空闲 8s；仅前台可见时轮询（codex 定稿的省电策略）
    Poller(key = "task-$taskId") {
        refresh()
        if (state?.turn == "running") 2500L else 8000L
    }

    // 列表 reverseLayout 锚定底部（index 0 = 最新）：进任务直接落在最后一条，流式文本增高也不会把尾巴顶出视野；
    // 贴近底部才自动跟随，上翻不抢滚动位置
    // （之前按 layoutInfo.totalItemsCount 算目标：effect 跑在布局之前，首帧时 total 还是 0，从不滚动）
    LaunchedEffect(state?.messages?.size, state?.partial.isNullOrBlank(), state?.turn, state?.pending?.size) {
        if (listState.firstVisibleItemIndex <= 2) listState.scrollToItem(0)
    }

    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(ImageEncoder.MAX_IMAGES)
    ) { uris ->
        scope.launch {
            val encoded = uris.mapNotNull { uri ->
                ImageEncoder.fromUri(context, uri)?.let { uri to it }
            }
            pendingImages = (pendingImages + encoded).take(ImageEncoder.MAX_IMAGES)
            if (encoded.size < uris.size) error = "部分图片读取失败或超过 5MB"
        }
    }

    fun send() {
        val text = input.trim()
        if (text.isBlank() && pendingImages.isEmpty()) return
        sending = true
        scope.launch {
            try {
                client.devSend(taskId, text, pendingImages.map { it.second })
                input = ""
                pendingImages = emptyList()
                refresh()
            } catch (e: Exception) {
                error = e.message
            } finally {
                sending = false
            }
        }
    }

    // 接管租约：take 取回输入权 / release 交还只旁观（web「接管输入 / 释放输入权」同款，POST /api/dev/control）
    fun setControl(action: String) {
        scope.launch {
            try {
                val r = client.devControl(taskId, action)
                if (!r.ok) error = r.msg
                refresh()
            } catch (e: Exception) {
                error = e.message
            }
        }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            // 顶栏 + 计划条 + 错误横幅同属玻璃层，消息流从底下穿过
            // （排队条挪到了输入框上方，见 OwnwardComposer 的 queued）
            Column(Modifier.glassBar()) {
                CenterAlignedTopAppBar(
                    title = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            StatusDot(
                                when {
                                    state == null -> MaterialTheme.colorScheme.onSurfaceVariant
                                    state!!.turn == "running" -> ownwardColors.Success
                                    state!!.alive -> ownwardColors.Accent
                                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                                }
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                when {
                                    state?.turn == "running" -> "运行中"
                                    state != null && state!!.control != "ownward" -> "只旁观"
                                    else -> "会话"
                                },
                                style = MaterialTheme.typography.titleSmall,
                            )
                        }
                    },
                    navigationIcon = { DrawerOrBackButton(onBack) },
                    actions = {
                        IconButton(onClick = { showInfo = true }) { Icon(Icons.Filled.Info, "详情") }
                    },
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = Color.Transparent),
                )
                state?.let { PlanStrip(it.plan) }
                // Runner 不可达时服务端回 stale 快照——必须可见，否则对着过期数据以为 agent 在干活
                if (state?.stale == true) {
                    Text(
                        "⚠ 数据可能过期（Runner 不可达${state?.errorCode?.let { "：$it" } ?: ""}）",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 2.dp),
                    )
                }
                ErrorBanner(error)
            }
        },
        bottomBar = {
            OwnwardComposer(
                input = input,
                onInput = { input = it },
                pendingImages = pendingImages,
                onRemoveImage = { uri -> pendingImages = pendingImages.filterNot { it.first == uri } },
                onPickImages = {
                    picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                },
                canSend = !sending && state?.control == "ownward" && state?.operability != "read-only",
                busy = sending,
                running = state?.turn == "running",
                queued = state?.queued ?: emptyList(),
                onCancelQueued = { q ->
                    scope.launch {
                        // 撤不到（本轮刚结束、这条已经合并发出了）服务端回 409，原因必须让用户看见。
                        // 用 snackbar 而不是顶部的 ErrorBanner：轮询 2.5s 一轮、refresh 成功就把 error 清空，
                        // 挂在 error 上的提示活不过一次轮询，根本来不及读。
                        val failure = runCatching { client.devQueueRemove(taskId, q.id) }.exceptionOrNull()
                        refresh()
                        if (failure != null) snackbar.showSnackbar(failure.message ?: "撤回失败")
                    }
                },
                controlHint = when {
                    state?.operability == "read-only" -> "会话已归档（只读）"
                    state?.control == "observing" -> "只旁观：输入权已释放"
                    state?.control == "external" -> "输入权在桌面终端（由其他端驱动）"
                    else -> null
                },
                // 释放过的会话可以在手机上直接接管回来（external 是别的端在驱动，和 web 一样不提供抢夺）
                controlAction = if (state?.control == "observing" && state?.operability != "read-only")
                    "接管输入" to { setControl("take") } else null,
                // 只有 claude 引擎会回报 slash_commands；codex 没有命令表就不开菜单（web/tasks.js 同款判断）
                commands = if (state?.backend == "claude") state?.commands ?: emptyList() else null,
                onSend = ::send,
                onInterrupt = {
                    scope.launch {
                        runCatching { client.devInterrupt(taskId) }.onFailure { error = it.message }
                        refresh()
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            state = listState,
            reverseLayout = true,
            // reverseLayout 默认把不满一屏的内容堆在底部；Top 保持短对话顶对齐，只有滚动起点变成底部
            verticalArrangement = Arrangement.Top,
            modifier = Modifier.fillMaxSize().hazeContent(),
            contentPadding = PaddingValues(
                top = padding.calculateTopPadding() + 8.dp,
                bottom = padding.calculateBottomPadding() + 8.dp,
            ),
        ) {
            // reverseLayout：先写的在底部——审批卡最下、再是流式文本/进行中指示、消息倒序；
            // key 用正序下标 / requestId（服务端 Map 键，唯一），追加时旧项不换位
            val pending = state?.pending ?: emptyList()
            items(pending.size, key = { "perm-" + pending[pending.size - 1 - it].requestId }) { i ->
                val perm = pending[pending.size - 1 - i]
                PermCard(perm = perm, submitted = perm.requestId in submitted) { allow, message, remember ->
                    submitted = submitted + perm.requestId
                    scope.launch {
                        runCatching {
                            client.devDecision(taskId, perm.requestId, allow, message, remember)
                        }.onFailure { error = it.message }
                        refresh()
                    }
                }
            }

            val partial = state?.partial ?: ""
            if (partial.isNotBlank()) {
                item(key = "partial") {
                    // agent 还在输出的这条同样长按可复制——复制已经吐出来的部分，不必等它写完
                    Box(
                        Modifier.fillMaxWidth()
                            .then(copyOnLongPress { partial })
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                    ) {
                        MarkdownText(partial)
                    }
                }
            } else if (state?.turn == "running") {
                item(key = "running") {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    ) {
                        ThinkingDots()
                        Text(
                            "agent 正在工作",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(start = 10.dp),
                        )
                    }
                }
            }

            // 连续工具调用折成一组（foldToolRuns）：一轮几十次 Edit/Bash 一条一行能把整屏铺满，
            // 而这段时间要看的只有「还在跑、第几步、有没有出错」。key 仍是正序下标——组的 key 是它的起点，
            // 尾部那组会一直长大但起点不动，追加时旧项不换位。
            val feed = foldToolRuns(state?.messages ?: emptyList())
            items(feed.size, key = { feed[feed.size - 1 - it].index }) { i ->
                // i==0 就是流的末尾（reverseLayout 下的第一项）：本轮还在跑时，这组显示「正在执行」
                FeedRow(feed[feed.size - 1 - i], live = i == 0 && state?.turn == "running", client = client)
            }
        }
    }

    if (showInfo && state != null) {
        val s = state!!
        val clipboard = LocalClipboardManager.current
        ModalBottomSheet(onDismissRequest = { showInfo = false }) {
            Column(Modifier.padding(horizontal = 24.dp).navigationBarsPadding()) {
                InfoRow("引擎", s.backend + (s.model?.let { " · $it" } ?: ""))
                InfoRow("控制权", when (s.control) {
                    "ownward" -> "ownward（可输入）"
                    "external" -> "桌面终端"
                    else -> "旁观（已释放输入权）"
                })
                s.tokens?.let {
                    val total = it.total ?: ((it.input ?: 0) + (it.output ?: 0))
                    InfoRow("token", "%.1fk".format(total / 1000.0))
                }
                s.ctxTokens?.let { InfoRow("上下文", "%.1fk".format(it / 1000.0)) }
                InfoRow("最近活动", timeAgo(s.lastActivityAt))
                // 接管租约切换（web detailHead 同款）：ownward → 可释放给桌面终端；observing → 接管回手机
                if (s.operability != "read-only") {
                    Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        when (s.control) {
                            "ownward" -> OutlinedButton(onClick = { showInfo = false; setControl("release") }) { Text("释放输入权") }
                            "observing" -> Button(onClick = { showInfo = false; setControl("take") }) { Text("接管输入") }
                        }
                    }
                }
                // 释放后在别的终端续聊的命令（服务端按 nativeRef 拼好），复制到剪贴板方便发给 Mac
                val cmd = s.resume?.cmd?.takeIf { it.isNotBlank() && s.control == "observing" }
                if (cmd != null) {
                    Text(
                        "在其他终端继续：", style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
                    )
                    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceVariant) {
                        Row(Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                cmd, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace,
                                modifier = Modifier.weight(1f),
                            )
                            TextButton(onClick = { clipboard.setText(AnnotatedString(cmd)) }) { Text("复制") }
                        }
                    }
                }
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(label, style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(80.dp))
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}
