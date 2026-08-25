package ai.ownward.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.SmartToy
import androidx.compose.material3.Button
import androidx.compose.material3.DrawerState
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ai.ownward.app.data.AiChat
import ai.ownward.app.data.OwnwardClient
import ai.ownward.app.data.RecentSession
import ai.ownward.app.data.WorkTask
import ai.ownward.app.ui.theme.ownwardColors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// ChatGPT 式侧边栏：任何页面左滑边缘 / 点顶栏 ☰ 拉出，带搜索，任务 / 对话一处选、一步切。
// 抽屉挂在 MainShell（ModalNavigationDrawer 包住整个 NavHost），各页只通过 LocalDrawer 开它。

/** 抽屉控制句柄：MainShell 提供；shell 外（Setup 页）为 null，顶栏的 ☰ 就不画 */
@Stable
class DrawerController(private val state: DrawerState, private val scope: CoroutineScope) {
    fun open() { scope.launch { state.open() } }
    fun close() { scope.launch { state.close() } }
}

val LocalDrawer = compositionLocalOf<DrawerController?> { null }

/** 列表页顶栏左侧的 ☰；抽屉不可用（Setup 页）时不画 */
@Composable
fun DrawerMenuButton() {
    val drawer = LocalDrawer.current ?: return
    IconButton(onClick = { drawer.open() }) { Icon(Icons.Filled.Menu, "菜单") }
}

/**
 * 详情页顶栏左侧：有抽屉就是 ☰（ChatGPT 同款——详情页即根页，返回仍走系统手势/返回键），
 * 没抽屉退回返回箭头，保证任何入口都出得去。
 */
@Composable
fun DrawerOrBackButton(onBack: () -> Unit) {
    val drawer = LocalDrawer.current
    if (drawer == null) {
        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") }
    } else {
        IconButton(onClick = { drawer.open() }) { Icon(Icons.Filled.Menu, "菜单") }
    }
}

/** 抽屉里能去的地方；MainShell 翻译成路由（详情类互相切换时替换当前详情页，返回栈不长高） */
sealed class DrawerDest {
    data object Inbox : DrawerDest()
    data object NewChat : DrawerDest()
    data object NewTask : DrawerDest()
    data object Settings : DrawerDest()
    data class Task(val id: String) : DrawerDest()
    data class Chat(val id: String) : DrawerDest()
    data class Terminal(val taskId: String, val ccId: String?) : DrawerDest()

    /** 与 MainShell 从返回栈算出的「当前页键」同一套字符串，用来高亮当前项 / 点到当前项时不重载 */
    fun key(): String = when (this) {
        Inbox -> "inbox"
        NewChat -> "chat:new"
        NewTask -> "dispatch"
        Settings -> "settings"
        is Task -> "task:$id"
        is Chat -> "chat:$id"
        is Terminal -> "terminal:$taskId"
    }
}

/** 抽屉三张表，各自 runCatching——一张失败不拖累其他；抽屉常驻组合树，数据关了再开先显旧的再刷新 */
private class DrawerData {
    var sessions by mutableStateOf<List<RecentSession>>(emptyList())
    var tasks by mutableStateOf<List<WorkTask>>(emptyList())
    var chats by mutableStateOf<List<AiChat>>(emptyList())
    var loaded by mutableStateOf(false)

    suspend fun refresh(client: OwnwardClient) = coroutineScope {
        val s = async { runCatching { client.recentSessions() } }
        val t = async { runCatching { client.tasks() } }
        val ch = async { runCatching { client.chatList() } }
        s.await().onSuccess { sessions = it }
        t.await().onSuccess { tasks = it }
        ch.await().onSuccess { chats = it }
        loaded = true
    }
}

/**
 * 抽屉内容。isOpen 用 targetValue（一开始滑就刷新，不等动画结束）；关上即停轮询、清搜索。
 * 不能用 Poller——抽屉常驻组合树，Poller 会在后台一直轮四张表。
 */
@Composable
fun AppDrawer(
    client: OwnwardClient,
    isOpen: Boolean,
    selectedKey: String?,
    onGo: (DrawerDest) -> Unit,
) {
    val data = remember { DrawerData() }
    var searching by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    val keyboard = LocalSoftwareKeyboardController.current

    LaunchedEffect(isOpen) {
        if (isOpen) {
            while (true) {
                data.refresh(client)
                delay(30_000)
            }
        } else {
            searching = false
            query = ""
        }
    }

    fun go(dest: DrawerDest) {
        keyboard?.hide()
        onGo(dest)
    }

    val q = query.trim()
    val running = data.sessions.filter { it.status == "running" && searchHit(q, it.title, it.project, it.last) }
    val terminal = data.tasks.filter {
        it.status == "running" && it.mode == "terminal" && searchHit(q, it.title, it.project, it.task)
    }
    val restAll = data.sessions.filter { it.status != "running" && searchHit(q, it.title, it.project, it.last) }
    val chatsAll = data.chats.filter { searchHit(q, it.title, it.provider, it.model) }
    // 不搜索时每段只放最近几条：历史任务多时，全铺出来底下的「对话」永远滚不到。
    // 截断必须说出来（下面的 DrawerMore 行），否则看起来像「就这些」。搜索时全展开。
    val rest = if (q.isEmpty()) restAll.take(12) else restAll
    val chats = if (q.isEmpty()) chatsAll.take(12) else chatsAll
    val nothing = running.isEmpty() && terminal.isEmpty() && rest.isEmpty() && chats.isEmpty()

    ModalDrawerSheet(
        drawerShape = RectangleShape,
        drawerContainerColor = MaterialTheme.colorScheme.surface,
        drawerContentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Column(Modifier.fillMaxSize()) {
            // 头：标题 + 圆形搜索钮；点搜索原位换成搜索框（ChatGPT 同款）
            Row(
                Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 12.dp, bottom = 4.dp).height(44.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (searching) {
                    SearchField(
                        value = query,
                        onValueChange = { query = it },
                        onClose = { searching = false; query = "" },
                        modifier = Modifier.weight(1f),
                    )
                } else {
                    Text(
                        "ownward",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.weight(1f),
                    )
                    RoundIconButton(Icons.Filled.Search, "搜索") { searching = true }
                }
            }

            LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
                if (q.isEmpty()) {
                    item { DrawerNavItem(Icons.Outlined.Inbox, "收件箱", selectedKey == "inbox") { go(DrawerDest.Inbox) } }
                    item { DrawerNavItem(Icons.Outlined.SmartToy, "派新任务", selectedKey == "dispatch") { go(DrawerDest.NewTask) } }
                }
                if (running.isNotEmpty() || terminal.isNotEmpty()) {
                    item { DrawerSection("运行中") }
                    items(running.size, key = { "run-" + running[it].id }) { i ->
                        val s = running[i]
                        EntityRow(
                            selected = selectedKey == "task:${s.id}", dot = ownwardColors.Success,
                            title = s.title.ifBlank { s.last }.ifBlank { "会话" },
                            sub = sessionSub(s.project, engineLabel(s.mode, s.backend, s.providerId), timeAgo(s.lastAt)),
                        ) { go(DrawerDest.Task(s.id)) }
                    }
                    items(terminal.size, key = { "term-" + terminal[it].id }) { i ->
                        val t = terminal[i]
                        EntityRow(
                            selected = selectedKey == "terminal:${t.id}", dot = ownwardColors.Success,
                            title = t.title?.ifBlank { null } ?: t.task,
                            sub = sessionSub(t.project, "terminal", timeAgoIso(t.startedAt)),
                        ) { go(DrawerDest.Terminal(t.id, t.ccSessionId)) }
                    }
                }
                if (rest.isNotEmpty()) {
                    item { DrawerSection("任务") }
                    items(rest.size, key = { "task-" + rest[it].id }) { i ->
                        val s = rest[i]
                        EntityRow(
                            selected = selectedKey == "task:${s.id}",
                            dot = if (s.status == "done") ownwardColors.Accent else MaterialTheme.colorScheme.onSurfaceVariant,
                            title = s.title.ifBlank { s.last }.ifBlank { "会话" },
                            sub = sessionSub(s.project, engineLabel(s.mode, s.backend, s.providerId), timeAgo(s.lastAt)),
                        ) { go(DrawerDest.Task(s.id)) }
                    }
                    item { DrawerMore(restAll.size - rest.size) }
                }
                if (chats.isNotEmpty()) {
                    item { DrawerSection("对话") }
                    items(chats.size, key = { "chat-" + chats[it].id }) { i ->
                        val c = chats[i]
                        EntityRow(
                            selected = selectedKey == "chat:${c.id}", dot = null,
                            title = c.title.ifBlank { "未命名对话" },
                            sub = sessionSub(c.provider, timeAgoIso(c.updatedAt)),
                        ) { go(DrawerDest.Chat(c.id)) }
                    }
                    item { DrawerMore(chatsAll.size - chats.size) }
                }
                if (nothing) {
                    item {
                        Text(
                            when {
                                !data.loaded -> "正在载入…"
                                q.isNotEmpty() -> "没有匹配「$q」的任务或对话"
                                else -> "还没有任务和对话"
                            },
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 20.dp, vertical = 24.dp),
                        )
                    }
                }
                item { Spacer(Modifier.height(8.dp)) }
            }

            // 底：「新对话」药丸 + 设置圆钮（ChatGPT 的「聊天」+ 齿轮同位）；sheet 自带系统栏 inset，不再加 padding
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Button(
                    onClick = { go(DrawerDest.NewChat) },
                    shape = CircleShape,
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
                ) {
                    Icon(Icons.Outlined.Edit, null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("新对话")
                }
                Spacer(Modifier.weight(1f))
                RoundIconButton(Icons.Outlined.Settings, "设置") { go(DrawerDest.Settings) }
            }
        }
    }
}

/** 顶部快捷项（ChatGPT 的 图片/资料库 那排）：图标 + 文字 */
@Composable
private fun DrawerNavItem(icon: ImageVector, label: String, selected: Boolean, onClick: () -> Unit) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = if (selected) MaterialTheme.colorScheme.surfaceContainerHighest else Color.Transparent,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 1.dp).clickable(onClick = onClick),
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, modifier = Modifier.size(22.dp))
            Spacer(Modifier.width(16.dp))
            Text(label, style = MaterialTheme.typography.bodyLarge)
        }
    }
}

/** 被截断的尾巴：明说还有多少条、去哪找，不装作「就这些」 */
@Composable
private fun DrawerMore(hidden: Int) {
    if (hidden <= 0) return
    Text(
        "还有 $hidden 条 · 用上面的搜索找",
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 2.dp),
    )
}

@Composable
private fun DrawerSection(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 4.dp),
    )
}

// 列表行 EntityRow / 搜索框 SearchField / 圆钮 RoundIconButton 都在 Components.kt——
// 任务页（AgentScreen）用的是同一套，两处列表的样式与搜索口径不会各走各的。
