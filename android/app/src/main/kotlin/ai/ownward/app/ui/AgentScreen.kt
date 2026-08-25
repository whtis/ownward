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
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ai.ownward.app.data.OwnwardClient
import ai.ownward.app.data.RecentSession
import ai.ownward.app.data.WorkTask
import ai.ownward.app.ui.theme.ownwardColors

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AgentScreen(
    client: OwnwardClient,
    onOpenTask: (String) -> Unit,
    onNewTask: () -> Unit,
    onOpenTerminal: (taskId: String, ccId: String?) -> Unit,
) {
    var sessions by remember { mutableStateOf<List<RecentSession>>(emptyList()) }
    var tasks by remember { mutableStateOf<List<WorkTask>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    // 搜索与侧边栏同一套（SearchField + searchHit）
    var searching by remember { mutableStateOf(false) }
    var query by remember { mutableStateOf("") }
    val keyboard = LocalSoftwareKeyboardController.current

    Poller(key = "agent-list") {
        try {
            sessions = client.recentSessions()
            error = null
        } catch (e: Exception) {
            error = e.message
        }
        30_000L
    }
    // terminal 任务表是慢数据，60s 一轮；失败不打扰主列表
    Poller(key = "agent-aux") {
        runCatching { client.tasks() }.onSuccess { tasks = it }
        60_000L
    }

    // 过滤口径与侧边栏逐字一致，同一个关键字在两处得到同一批结果
    val q = query.trim()
    val running = sessions.filter { it.status == "running" && searchHit(q, it.title, it.project, it.last) }
    val rest = sessions.filter { it.status != "running" && searchHit(q, it.title, it.project, it.last) }
    val terminalRunning = remember(tasks, q) {
        tasks.filter { it.status == "running" && it.mode == "terminal" && searchHit(q, it.title, it.project, it.task) }
    }

    fun open(go: () -> Unit) {
        keyboard?.hide()
        go()
    }

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
                        placeholder = "搜索任务、会话",
                        modifier = Modifier.fillMaxWidth(),
                    ) else Text("Agent", fontWeight = FontWeight.Bold)
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
            // 派新任务：悬浮在玻璃导航栏上方（与对话页「新对话」同位）
            FloatingActionButton(
                onClick = onNewTask,
                modifier = Modifier.padding(bottom = LocalBottomBarPadding.current),
            ) { Icon(Icons.Filled.Add, "新任务") }
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
            // 只展示 Ownward 任务；terminal 任务仍可进入旁观/接管页
            if (running.isNotEmpty() || terminalRunning.isNotEmpty()) {
                item { SectionHeader("运行中") }
                items(running.size, key = { "run-" + running[it].id }) { i ->
                    val s = running[i]
                    EntityRow(
                        dot = ownwardColors.Success,
                        title = s.title.ifBlank { s.last }.ifBlank { "会话" },
                        sub = sessionSub(s.project, engineLabel(s.mode, s.backend, s.providerId), timeAgo(s.lastAt)),
                    ) { open { onOpenTask(s.id) } }
                }
                items(terminalRunning.size, key = { "term-" + terminalRunning[it].id }) { i ->
                    val t = terminalRunning[i]
                    // terminal 任务在 Mac 的 Terminal 窗口里跑：手机只能旁观底层会话，或接管到引擎
                    EntityRow(
                        dot = ownwardColors.Success,
                        title = t.title?.ifBlank { null } ?: t.task,
                        sub = sessionSub(t.project, "terminal", timeAgoIso(t.startedAt)),
                    ) { open { onOpenTerminal(t.id, t.ccSessionId) } }
                }
            }
            if (rest.isNotEmpty()) {
                item { SectionHeader("任务") }
                items(rest.size, key = { "task-" + rest[it].id }) { i ->
                    val s = rest[i]
                    EntityRow(
                        dot = if (s.status == "done") ownwardColors.Accent
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                        title = s.title.ifBlank { s.last }.ifBlank { "会话" },
                        sub = sessionSub(s.project, engineLabel(s.mode, s.backend, s.providerId), timeAgo(s.lastAt)),
                    ) { open { onOpenTask(s.id) } }
                }
            }
            if (running.isEmpty() && rest.isEmpty() &&
                terminalRunning.isEmpty() && error == null
            ) {
                item {
                    Text(
                        if (q.isNotEmpty()) "没有匹配「$q」的任务或会话"
                        else "还没有 agent 会话，点右下角派一个",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(32.dp),
                    )
                }
            }
        }
    }
}
