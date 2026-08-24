package ai.ownward.app.ui

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ai.ownward.app.data.AiChat
import ai.ownward.app.data.OwnwardClient
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatListScreen(client: OwnwardClient, onOpenChat: (String) -> Unit, onNewChat: () -> Unit) {
    var chats by remember { mutableStateOf<List<AiChat>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf<AiChat?>(null) }
    // 搜索与侧边栏、Agent 页同一套（SearchField + searchHit + EntityRow）
    var searching by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    val keyboard = LocalSoftwareKeyboardController.current
    val scope = rememberCoroutineScope()

    suspend fun refresh() {
        try {
            chats = client.chatList(); error = null
        } catch (e: Exception) {
            error = e.message
        }
    }

    Poller(key = "chat-list") { refresh(); 60_000L }

    // 过滤口径与侧边栏逐字一致（标题 + 供应商 + 模型），同一个关键字两处得到同一批结果
    val q = query.trim()
    val shown = chats.filter { searchHit(q, it.title, it.provider, it.model) }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets.statusBars,
        topBar = {
            TopAppBar(
                // 搜索原位替换标题（侧边栏同款）：展开时让出 ☰ 与右侧钮，搜索框铺满顶栏
                title = {
                    if (searching) SearchField(
                        value = query,
                        onValueChange = { query = it },
                        onClose = { searching = false; query = "" },
                        placeholder = "搜索对话",
                        modifier = Modifier.fillMaxWidth(),
                    ) else Text("对话", fontWeight = FontWeight.Bold)
                },
                navigationIcon = { if (!searching) DrawerMenuButton() },
                actions = {
                    if (!searching) {
                        RoundIconButton(Icons.Filled.Search, "搜索") { searching = true }
                        Spacer(Modifier.width(12.dp))
                    }
                },
                modifier = Modifier.glassBar(),
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
            )
        },
        floatingActionButton = {
            // 悬浮在玻璃导航栏上方
            FloatingActionButton(
                onClick = onNewChat,
                modifier = Modifier.padding(bottom = LocalBottomBarPadding.current),
            ) { Icon(Icons.Filled.Add, "新对话") }
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().hazeContent(),
            contentPadding = PaddingValues(
                top = padding.calculateTopPadding() + 4.dp,
                bottom = LocalBottomBarPadding.current + 16.dp,
            ),
        ) {
            item { ErrorBanner(error) }
            items(shown.size, key = { "chat-" + shown[it].id }) { i ->
                val chat = shown[i]
                EntityRow(
                    title = chat.title.ifBlank { "未命名对话" },
                    sub = sessionSub(chat.provider, chat.model, timeAgoIso(chat.updatedAt)),
                    trailing = {
                        IconButton(onClick = { confirmDelete = chat }) {
                            Icon(Icons.Filled.DeleteOutline, "删除",
                                tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    },
                ) { keyboard?.hide(); onOpenChat(chat.id) }
            }
            if (shown.isEmpty() && error == null) {
                item {
                    Text(
                        if (q.isNotEmpty()) "没有匹配「$q」的对话"
                        else "还没有对话，点右下角开始",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(32.dp),
                    )
                }
            }
        }
    }

    confirmDelete?.let { chat ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text("删除对话") },
            text = { Text("删除「${chat.title.ifBlank { "未命名对话" }}」？附件也会一并删除。") },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = {
                    confirmDelete = null
                    scope.launch { runCatching { client.chatDelete(chat.id) }; refresh() }
                }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                androidx.compose.material3.TextButton(onClick = { confirmDelete = null }) { Text("取消") }
            },
        )
    }
}
