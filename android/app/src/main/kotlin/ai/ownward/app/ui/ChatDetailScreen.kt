package ai.ownward.app.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import ai.ownward.app.data.AiMessage
import ai.ownward.app.data.ChatEvent
import ai.ownward.app.data.OwnwardClient
import ai.ownward.app.data.ImageEncoder
import ai.ownward.app.data.OutImage
import ai.ownward.app.ui.theme.ownwardColors
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatDetailScreen(client: OwnwardClient, chatId: String?, onBack: () -> Unit) {
    var currentChatId by remember { mutableStateOf(chatId) }
    var messages by remember { mutableStateOf<List<AiMessage>>(emptyList()) }
    var providers by remember { mutableStateOf(mapOf<String, List<String>>()) }
    // 默认 ChatGPT（codex）：日常快聊的首选；claude 引擎在模型菜单一步可切
    var provider by remember { mutableStateOf("codex") }
    var model by remember { mutableStateOf("default") }
    var title by remember { mutableStateOf("") }
    var input by remember { mutableStateOf("") }
    var pendingImages by remember { mutableStateOf<List<Pair<Uri, OutImage>>>(emptyList()) }
    var streaming by remember { mutableStateOf(false) }
    var streamText by remember { mutableStateOf("") }
    var toolLine by remember { mutableStateOf("") }
    // 乐观气泡的本地图片预览（发送成功后由服务端版本替换）
    var optimisticImages by remember { mutableStateOf<List<Uri>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var modelMenu by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val listState = rememberLazyListState()

    LaunchedEffect(chatId) {
        runCatching { providers = client.chatProviders() }
        // 新对话取该供应商型号表第一个（配置里排在首位的即默认，如 gpt-5.6-sol）；
        // 既有对话跟随会话已存的 provider/model
        if (chatId == null) providers[provider]?.firstOrNull()?.let { model = it }
        else providers[provider]?.firstOrNull()?.let { if (model !in (providers[provider] ?: emptyList())) model = it }
        if (chatId != null) {
            try {
                val chat = client.chatMessages(chatId)
                messages = chat.messages
                provider = chat.provider
                model = chat.model
                title = chat.title
            } catch (e: Exception) {
                error = e.message
            }
        }
    }

    // 列表 reverseLayout 锚定底部（index 0 = 最新）：进会话直接落在最后一条，流式气泡增高也不会把尾巴顶出视野。
    // 贴近底部才自动跟随新消息，上翻不抢滚动位置。
    // （之前按 layoutInfo.totalItemsCount 算目标：effect 跑在布局之前，首次载入时 total 还是 0，从不滚动）
    LaunchedEffect(messages.size, streaming) {
        if (listState.firstVisibleItemIndex <= 2) listState.scrollToItem(0)
    }

    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(ImageEncoder.MAX_IMAGES)
    ) { uris ->
        scope.launch {
            val encoded = uris.mapNotNull { uri -> ImageEncoder.fromUri(context, uri)?.let { uri to it } }
            pendingImages = (pendingImages + encoded).take(ImageEncoder.MAX_IMAGES)
            if (encoded.size < uris.size) error = "部分图片读取失败或超过 5MB"
        }
    }

    fun send() {
        val text = input.trim()
        val images = pendingImages
        if ((text.isBlank() && images.isEmpty()) || streaming) return
        // 乐观提交：无 done 帧就回滚（对齐 web/chat.js 的事务语义）
        val optimistic = AiMessage(
            role = "user",
            text = text.ifBlank { if (images.size > 1) "看一下这几张图" else "看一下这张图" },
            ts = java.time.Instant.now().toString(),
        )
        messages = messages + optimistic
        optimisticImages = images.map { it.first }
        input = ""
        pendingImages = emptyList()
        streaming = true
        streamText = ""
        toolLine = ""
        error = null
        scope.launch {
            var gotDone = false
            try {
                client.chatSend(currentChatId, text, provider, model, images.map { it.second })
                    .collect { ev ->
                        when (ev) {
                            is ChatEvent.Delta -> streamText += ev.text
                            is ChatEvent.Tool -> toolLine = ev.text
                            is ChatEvent.Error -> error = ev.msg
                            is ChatEvent.Done -> {
                                gotDone = true
                                currentChatId = ev.chat.id
                                messages = ev.chat.messages
                                title = ev.chat.title
                            }
                        }
                    }
            } catch (e: Exception) {
                error = e.message
            } finally {
                streaming = false
                streamText = ""
                toolLine = ""
                optimisticImages = emptyList()
                if (!gotDone) {
                    // 服务端没落盘：撤回气泡，还原草稿
                    messages = messages.dropLast(1)
                    input = text
                    pendingImages = images
                    if (error == null) error = "发送中断，草稿已恢复"
                }
            }
        }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            // 顶栏 + 错误横幅同属玻璃层，消息流从底下穿过
            Column(Modifier.glassBar()) {
                CenterAlignedTopAppBar(
                    title = {
                        Box {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = if (currentChatId == null)
                                    Modifier.clickable { modelMenu = true } else Modifier,
                            ) {
                                Text(
                                    if (currentChatId == null) "$provider · $model"
                                    else title.ifBlank { "新对话" },
                                    style = MaterialTheme.typography.titleSmall,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                if (currentChatId == null) Icon(
                                    Icons.Filled.ArrowDropDown, null,
                                    tint = ownwardColors.TextDim,
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                            DropdownMenu(expanded = modelMenu, onDismissRequest = { modelMenu = false }) {
                                // 供应商键来自服务端配置（可含 codex-alt 第二账号等），逐键平铺
                                providers.forEach { (prov, models) ->
                                    models.forEach { m ->
                                        DropdownMenuItem(
                                            text = { Text("$prov · $m") },
                                            onClick = { provider = prov; model = m; modelMenu = false },
                                        )
                                    }
                                }
                            }
                        }
                    },
                    navigationIcon = { DrawerOrBackButton(onBack) },
                    colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = Color.Transparent),
                )
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
                canSend = !streaming,
                busy = streaming,
                onSend = ::send,
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
            // reverseLayout：先写的在底部——流式气泡最下、消息倒序；key 用正序下标，追加新消息时旧项不换位
            if (streaming) {
                item(key = "stream") {
                    // 还在输出的这条同样长按可复制——复制已经吐出来的部分，不必等它写完
                    Box(
                        Modifier.fillMaxWidth()
                            .then(copyOnLongPress { streamText })
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                    ) {
                        if (streamText.isNotBlank()) MarkdownText(streamText)
                        else Row(verticalAlignment = Alignment.CenterVertically) {
                            ThinkingDots()
                            if (toolLine.isNotBlank()) Text(
                                toolLine,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.padding(start = 10.dp),
                            )
                        }
                    }
                }
            }
            items(messages.size, key = { messages.size - 1 - it }) { i ->
                val idx = messages.size - 1 - i
                ChatMessageRow(
                    msg = messages[idx],
                    chatId = currentChatId,
                    client = client,
                    localImages = if (idx == messages.size - 1 && optimisticImages.isNotEmpty())
                        optimisticImages else emptyList(),
                )
            }
        }
    }
}

@Composable
private fun ChatMessageRow(
    msg: AiMessage,
    chatId: String?,
    client: OwnwardClient,
    localImages: List<Uri>,
) {
    val context = LocalContext.current
    val copy = copyOnLongPress { msg.text }
    if (msg.role == "user") {
        Column(
            Modifier.fillMaxWidth().padding(start = 56.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (localImages.isNotEmpty()) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    localImages.forEach { uri ->
                        AsyncImage(
                            model = uri, contentDescription = null,
                            modifier = Modifier
                                .size(96.dp)
                                .clip(RoundedCornerShape(12.dp))
                                .background(MaterialTheme.colorScheme.surfaceVariant),
                        )
                    }
                }
            } else if (msg.images.isNotEmpty() && chatId != null) {
                val auth = client.authHeader()
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    msg.images.forEach { img ->
                        AsyncImage(
                            model = ImageRequest.Builder(context)
                                .data(client.chatImageUrl(chatId, img.id))
                                .apply { auth?.let { (h, v) -> setHeader(h, v) } }
                                .build(),
                            contentDescription = null,
                            modifier = Modifier
                                .size(96.dp)
                                .clip(RoundedCornerShape(12.dp))
                                .background(MaterialTheme.colorScheme.surfaceVariant),
                        )
                    }
                }
            }
            if (msg.text.isNotBlank()) {
                Surface(shape = RoundedCornerShape(20.dp), color = ownwardColors.UserBubble, modifier = copy) {
                    Text(
                        msg.text,
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    )
                }
            }
        }
    } else {
        Box(Modifier.fillMaxWidth().then(copy).padding(horizontal = 16.dp, vertical = 8.dp)) {
            MarkdownText(msg.text)
        }
    }
}
