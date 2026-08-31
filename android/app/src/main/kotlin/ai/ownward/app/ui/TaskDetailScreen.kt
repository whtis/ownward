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
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
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
import ai.ownward.app.data.ApiException
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
    var providers by remember { mutableStateOf(mapOf<String, List<String>>()) }
    var handoffTarget by remember { mutableStateOf<String?>(null) }
    var handoffProvider by remember { mutableStateOf("") }
    var handoffModel by remember { mutableStateOf("") }
    var handoffEffort by remember { mutableStateOf("") }
    var handoffError by remember { mutableStateOf<String?>(null) }
    var confirmUnknownHandoff by remember { mutableStateOf(false) }
    var switching by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val listState = rememberLazyListState()
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(Unit) {
        runCatching { client.chatProviders() }.onSuccess { providers = it }
    }

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
                        IconButton(onClick = {
                            state?.let { s ->
                                val currentProvider = agentProvider(s)
                                handoffProvider = currentProvider
                                handoffModel = s.model.orEmpty()
                                handoffEffort = s.effort.orEmpty()
                                handoffError = null
                            }
                            showInfo = true
                        }) { Icon(Icons.Filled.Info, "详情") }
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
            Column(
                Modifier
                    .padding(horizontal = 24.dp)
                    .navigationBarsPadding()
                    .verticalScroll(rememberScrollState()),
            ) {
                val currentProvider = agentProvider(s)
                InfoRow("Provider", currentProvider)
                InfoRow("模型", s.model?.takeIf { it.isNotBlank() } ?: "Provider 默认")
                InfoRow("思考深度", s.effort?.takeIf { it.isNotBlank() } ?: "Provider 默认")
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
                Text("会话配置", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 16.dp))
                val handoffBlock = handoffBlockReason(s)
                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("claude", "codex", "codebuddy").forEach { provider ->
                        val selectProvider = {
                            handoffProvider = provider
                            if (provider == currentProvider) {
                                handoffModel = s.model.orEmpty()
                                handoffEffort = s.effort.orEmpty()
                            } else {
                                handoffModel = workProviderHandoffModel(provider)
                                handoffEffort = workProviderDefaultEffort(provider, handoffModel)
                            }
                            handoffError = null
                        }
                        val content = @Composable { Text(provider) }
                        if (handoffProvider == provider) Button(
                            enabled = handoffBlock == null && !switching,
                            onClick = selectProvider,
                            content = { content() },
                        ) else OutlinedButton(
                            enabled = handoffBlock == null && !switching,
                            onClick = selectProvider,
                            content = { content() },
                        )
                    }
                }
                val sameProvider = handoffProvider == currentProvider
                val modelOptions = buildList {
                    if (sameProvider && s.model.isNullOrBlank()) add("")
                    addAll(workProviderModels(handoffProvider, providers))
                    if (handoffModel.isNotBlank()) add(handoffModel)
                }.distinct()
                SessionConfigPicker(
                    label = "模型",
                    value = handoffModel,
                    options = modelOptions,
                    emptyLabel = "Provider 默认",
                    onSelect = {
                        handoffModel = it
                        if (!(sameProvider && handoffEffort.isBlank())) {
                            handoffEffort = handoffEffort.takeIf { value -> value in workProviderEfforts(handoffProvider, it) }
                                ?: workProviderDefaultEffort(handoffProvider, it)
                        }
                        handoffError = null
                    },
                )
                val allowedEfforts = workProviderEfforts(handoffProvider, handoffModel)
                val effortOptions = buildList {
                    if (sameProvider && s.effort.isNullOrBlank()) add("")
                    if (handoffEffort.isNotBlank() && handoffEffort !in allowedEfforts) add(handoffEffort)
                    addAll(allowedEfforts)
                }
                SessionConfigPicker(
                    label = "思考深度",
                    value = handoffEffort,
                    options = effortOptions,
                    emptyLabel = "Provider 默认",
                    onSelect = { handoffEffort = it; handoffError = null },
                )
                val configNoop = sessionConfigIsNoop(
                    currentProvider, s.model.orEmpty(), s.effort.orEmpty(),
                    handoffProvider, handoffModel, handoffEffort,
                )
                val configValid = handoffProvider.isNotBlank() &&
                    workProviderSelectionIsValid(handoffProvider, handoffModel, handoffEffort, allowOmitted = sameProvider)
                Button(
                    enabled = handoffBlock == null && !switching && configValid && !configNoop,
                    onClick = {
                        confirmUnknownHandoff = false
                        handoffError = null
                        handoffTarget = handoffProvider
                    },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                ) { Text(if (sameProvider) "应用配置" else "切换引擎并应用") }
                if (handoffBlock != null) {
                    Text(
                        handoffBlock,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
                if (configNoop && handoffBlock == null) {
                    Text(
                        "请选择不同的模型、思考深度或 Provider",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
                handoffError?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
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

    handoffTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { if (!switching) { handoffTarget = null; confirmUnknownHandoff = false } },
            title = { Text(if (confirmUnknownHandoff) "确认未知副作用后切换？" else if (target == state?.let(::agentProvider)) "应用会话配置？" else "切换到 $target？") },
            text = {
                Text(if (confirmUnknownHandoff)
                    "旧 Run 的执行结果未知，可能已经产生文件或命令副作用。继续接力不会重放旧命令，请先核对工作区状态。"
                else if (target == state?.let(::agentProvider)) "当前会话的有界历史会保留，新的模型和思考深度从下一轮生效。"
                else "当前会话的有界历史会保留，新引擎将接力继续这个任务。")
            },
            dismissButton = { TextButton(enabled = !switching, onClick = { handoffTarget = null; confirmUnknownHandoff = false }) { Text("取消") } },
            confirmButton = {
                Button(enabled = !switching, onClick = {
                    switching = true
                    scope.launch {
                        try {
                            val currentProvider = state?.let(::agentProvider).orEmpty()
                            if (sessionConfigIsNoop(
                                    currentProvider, state?.model.orEmpty(), state?.effort.orEmpty(),
                                    target, handoffModel, handoffEffort,
                                )) {
                                handoffTarget = null
                                handoffError = "配置没有变化"
                                return@launch
                            }
                            if (!workProviderSelectionIsValid(
                                    target, handoffModel, handoffEffort,
                                    allowOmitted = target == currentProvider,
                                )) {
                                handoffTarget = null
                                handoffError = "所选模型不支持这个思考深度"
                                return@launch
                            }
                            client.devHandoff(
                                id = taskId,
                                providerId = target,
                                confirmUnknownOutcome = confirmUnknownHandoff,
                                model = handoffModel,
                                effort = handoffEffort,
                                reason = if (target == currentProvider) "manual-reconfigure" else "manual-handoff",
                            )
                            handoffTarget = null
                            confirmUnknownHandoff = false
                            showInfo = false
                            refresh()
                        } catch (e: Exception) {
                            if (needsUnknownHandoffConfirmation(e)) {
                                confirmUnknownHandoff = true
                            } else {
                                handoffTarget = null
                                handoffError = e.message ?: "应用配置失败"
                            }
                        } finally {
                            switching = false
                        }
                    }
                }) { Text(if (switching) "切换中…" else if (confirmUnknownHandoff) "理解风险，继续" else "确认切换") }
            },
        )
    }
}

fun needsUnknownHandoffConfirmation(error: Throwable): Boolean =
    error is ApiException && error.errorCode == "SESSION_HANDOFF_UNKNOWN_CONFIRM_REQUIRED"

fun handoffBlockReason(state: AgentState): String? = when {
    state.control != "ownward" -> "仅 ownward 持有输入权时可切换"
    state.turn == "running" -> "当前轮次运行中，请等待结束或先中断"
    state.pending.isNotEmpty() -> "有待处理的审批，请先确认"
    state.queued.isNotEmpty() -> "有排队消息，请先等待发送或撤回"
    state.operability == "read-only" -> "会话已归档，不能切换"
    else -> null
}

fun agentProvider(state: AgentState): String =
    state.providerId?.takeIf { it.isNotBlank() } ?: state.backend.ifBlank { "claude" }

fun sessionConfigIsNoop(
    currentProvider: String,
    currentModel: String,
    currentEffort: String,
    provider: String,
    model: String,
    effort: String,
): Boolean = currentProvider == provider && currentModel == model && currentEffort == effort

@Composable
private fun SessionConfigPicker(
    label: String,
    value: String,
    options: List<String>,
    emptyLabel: String,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Surface(
            shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.fillMaxWidth().clickable { expanded = true },
        ) {
            Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(label, style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.weight(1f))
                Text(value.ifBlank { emptyLabel }, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                Icon(Icons.Filled.ArrowDropDown, null, modifier = Modifier.size(20.dp))
            }
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.distinct().forEach { option ->
                DropdownMenuItem(
                    text = { Text(option.ifBlank { emptyLabel }) },
                    onClick = { onSelect(option); expanded = false },
                )
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
