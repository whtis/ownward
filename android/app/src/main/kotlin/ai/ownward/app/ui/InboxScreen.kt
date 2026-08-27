package ai.ownward.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ai.ownward.app.data.Action
import ai.ownward.app.data.AttentionItem
import ai.ownward.app.data.OwnwardClient
import ai.ownward.app.data.Meeting
import ai.ownward.app.data.PendingPerm
import ai.ownward.app.data.RoutineCard
import ai.ownward.app.ui.theme.ownwardColors
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

data class TaskPerm(val taskId: String, val project: String, val perm: PendingPerm)

internal fun routineCanEdit(status: String) = status == "draft"

internal fun routineCanSubmit(status: String, loadedSuccessfully: Boolean) =
    loadedSuccessfully && routineCanEdit(status)

internal fun routineActions(r: RoutineCard): Set<String> = buildSet {
    if (r.status == "pending") add("generate")
    if (r.hasDraft) add("view")
    if (r.status == "draft") add("skip")
    if (r.status == "writing" && !r.taskId.isNullOrBlank()) add("task")
    if (!r.docUrl.isNullOrBlank()) add("document")
}

internal suspend fun saveThenWrite(
    save: suspend () -> Unit,
    write: suspend () -> Unit,
) {
    save()
    write()
}

private class InboxState {
    var meetings by mutableStateOf<List<Meeting>>(emptyList())
    var perms by mutableStateOf<List<TaskPerm>>(emptyList())
    var attention by mutableStateOf<List<AttentionItem>>(emptyList())
    var routines by mutableStateOf<List<RoutineCard>>(emptyList())
    var actions by mutableStateOf<List<Action>>(emptyList())
    var error by mutableStateOf<String?>(null)
    var submitted by mutableStateOf(setOf<String>())
    var loadedOnce by mutableStateOf(false)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(
    client: OwnwardClient,
    onOpenTask: (String) -> Unit,
    onOpenChat: (String) -> Unit,
    onOpenSettings: () -> Unit,
) {
    val st = remember { InboxState() }
    val scope = rememberCoroutineScope()

    suspend fun refresh() {
        try {
            coroutineScope {
                val actions = async { client.actions() }
                val attention = async { client.attention() }
                val routines = async { client.routines() }
                val tasks = async { client.tasks() }
                val perms = tasks.await()
                    .filter { it.status == "running" && it.mode != "terminal" }
                    .map { t ->
                        async {
                            runCatching { client.devMessages(t.id) }.getOrNull()
                                ?.pending?.map { TaskPerm(t.id, t.project, it) } ?: emptyList()
                        }
                    }.flatMap { it.await() }
                st.actions = actions.await().filter { it.state == "open" || it.state == "snoozed" }
                st.attention = attention.await()
                st.routines = routines.await().filter { it.isToday || it.overdue || it.hasDraft }
                st.perms = perms
                st.error = null
                st.loadedOnce = true
            }
        } catch (e: Exception) {
            st.error = e.message
        }
    }

    // 会议单独拉：lark-cli 可能要 30s，别拖住主刷新
    Poller(key = "inbox-meetings") {
        runCatching { st.meetings = client.calendarToday() }
        300_000L
    }
    Poller(key = "inbox") {
        refresh()
        60_000L
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets.statusBars, // 底部让位交给玻璃导航栏高度（LocalBottomBarPadding）
        topBar = {
            TopAppBar(
                title = { Text("收件箱", fontWeight = FontWeight.Bold) },
                navigationIcon = { DrawerMenuButton() },
                modifier = Modifier.glassBar(),
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                actions = {
                    IconButton(onClick = { scope.launch { refresh() } }) {
                        Icon(Icons.Filled.Refresh, "刷新")
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Filled.Settings, "设置")
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().hazeContent(),
            contentPadding = PaddingValues(
                top = padding.calculateTopPadding() + 4.dp,
                bottom = LocalBottomBarPadding.current + 16.dp,
            ),
        ) {
            item { ErrorBanner(st.error) }

            if (st.meetings.isNotEmpty()) item { MeetingStrip(st.meetings) }

            if (st.perms.isNotEmpty()) {
                item { SectionHeader("等你决定") }
                items(st.perms.size) { i ->
                    val tp = st.perms[i]
                    Column(Modifier.clickable { onOpenTask(tp.taskId) }) {
                        Text(
                            tp.project,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(start = 16.dp, top = 4.dp),
                        )
                        PermCard(
                            perm = tp.perm,
                            submitted = tp.perm.requestId in st.submitted,
                        ) { allow, message, remember ->
                            st.submitted = st.submitted + tp.perm.requestId
                            scope.launch {
                                runCatching {
                                    client.devDecision(tp.taskId, tp.perm.requestId, allow, message, remember)
                                }.onFailure { st.error = it.message }
                                refresh()
                            }
                        }
                    }
                }
            }

            if (st.attention.isNotEmpty()) {
                item { SectionHeader("agent 状态") }
                items(st.attention.size) { i -> AttentionRow(st.attention[i], onOpenTask) }
            }

            val dueRoutines = st.routines
            if (dueRoutines.isNotEmpty()) {
                item { SectionHeader("例行") }
                items(dueRoutines.size, key = { i -> "${dueRoutines[i].id}:${dueRoutines[i].date}" }) { i ->
                    RoutineRow(dueRoutines[i], client, onOpenTask) { scope.launch { refresh() } }
                }
            }

            if (st.actions.isNotEmpty()) {
                item { SectionHeader("行动卡") }
                items(st.actions.size) { i ->
                    ActionCard(st.actions[i], client, onOpenTask, onOpenChat) { scope.launch { refresh() } }
                }
            }

            if (st.loadedOnce && st.perms.isEmpty() && st.attention.isEmpty() &&
                st.actions.isEmpty() && dueRoutines.isEmpty()
            ) {
                item {
                    Text(
                        "没有需要处理的事项",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(32.dp),
                    )
                }
            }
        }
    }
}

/** "2026-08-14T09:30:00+08:00" → "09:30"；解析不出就原样返回 */
private fun fmtClock(iso: String): String {
    val t = iso.indexOf('T')
    return if (t > 0 && iso.length >= t + 6) iso.substring(t + 1, t + 6) else iso
}

@Composable
private fun MeetingStrip(meetings: List<Meeting>) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        val uriHandler = LocalUriHandler.current
        meetings.forEach { m ->
            Surface(
                shape = MaterialTheme.shapes.medium,
                color = MaterialTheme.colorScheme.surface,
                modifier = if (m.meetingUrl.isNullOrBlank()) Modifier else Modifier.clickable {
                    runCatching { uriHandler.openUri(m.meetingUrl!!) }
                },
            ) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    Text(
                        "${fmtClock(m.start)}–${fmtClock(m.end)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    Text(m.title, style = MaterialTheme.typography.bodySmall, maxLines = 1)
                }
            }
        }
    }
}

@Composable
private fun AttentionRow(item: AttentionItem, onOpenTask: (String) -> Unit) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 3.dp)
            .clickable { onOpenTask(item.taskId) },
    ) {
        Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusDot(if (item.kind == "stuck") ownwardColors.Warn else ownwardColors.Success)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text("${item.project} · ${item.title}", style = MaterialTheme.typography.bodyMedium, maxLines = 1)
                Text(item.detail, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
            }
        }
    }
}

@Composable
private fun RoutineRow(
    r: RoutineCard,
    client: OwnwardClient,
    onOpenTask: (String) -> Unit,
    onChanged: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current
    var reviewing by remember(r.id, r.date) { mutableStateOf(false) }
    var loading by remember(r.id, r.date) { mutableStateOf(false) }
    var loadedSuccessfully by remember(r.id, r.date) { mutableStateOf(false) }
    var loadError by remember(r.id, r.date) { mutableStateOf<String?>(null) }
    var submitting by remember(r.id, r.date) { mutableStateOf(false) }
    var content by remember(r.id, r.date) { mutableStateOf("") }
    var draftStatus by remember(r.id, r.date) { mutableStateOf(r.status) }
    var draftStale by remember(r.id, r.date) { mutableStateOf(r.stale) }
    var error by remember(r.id, r.date) { mutableStateOf<String?>(null) }

    fun openDraft() {
        reviewing = true
        loading = true
        loadedSuccessfully = false
        loadError = null
        scope.launch {
            try {
                val draft = client.routineDraft(r.id, r.date)
                content = draft.draft
                draftStatus = draft.status
                draftStale = draft.stale
                loadedSuccessfully = true
            } catch (e: Exception) {
                loadError = e.message ?: "读取草稿失败"
            } finally {
                loading = false
            }
        }
    }

    fun submit(action: suspend () -> Unit, close: Boolean = false) {
        if (submitting) return
        submitting = true
        error = null
        scope.launch {
            try {
                action()
                if (close) reviewing = false
                onChanged()
            } catch (e: Exception) {
                error = e.message ?: "操作失败"
            } finally {
                submitting = false
            }
        }
    }

    val actions = routineActions(r)
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 3.dp),
    ) {
        Column {
            Row(Modifier.padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(r.name, style = MaterialTheme.typography.bodyMedium)
                    Text(
                        when (r.status) {
                            "pending" -> if (r.overdue) "已到期，待生成" else "今天 ${r.time}"
                            "draft" -> "草稿待审"
                            "writing" -> "正在写入…"
                            "written" -> "已写入"
                            "skipped" -> "已跳过"
                            else -> r.nextLabel
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = if (r.overdue || r.stale) ownwardColors.Warn else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (r.stale) Text("素材已更新，草稿可能过期", style = MaterialTheme.typography.bodySmall, color = ownwardColors.Warn)
                }
                if ("generate" in actions) TextButton(enabled = !submitting, onClick = {
                    submit({ client.routineGenerate(r.id) })
                }) { Text("生成草稿") }
                if ("view" in actions) TextButton(enabled = !loading, onClick = ::openDraft) { Text("查看") }
                if ("task" in actions) TextButton(onClick = { onOpenTask(r.taskId!!) }) { Text("查看任务") }
                if ("document" in actions) TextButton(onClick = { uriHandler.openUri(r.docUrl!!) }) { Text("原文") }
                if ("skip" in actions) TextButton(enabled = !submitting, onClick = {
                    submit({ client.routineSkip(r.id, r.date) })
                }) { Text("跳过", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 2.dp)) }
        }
    }

    if (reviewing) AlertDialog(
        onDismissRequest = { if (!submitting) reviewing = false },
        title = { Text(r.name) },
        text = {
            Column {
                if (loading) CircularProgressIndicator()
                else if (!loadedSuccessfully) {
                    Text(loadError ?: "草稿未加载", color = MaterialTheme.colorScheme.error)
                    TextButton(onClick = ::openDraft) { Text("重试") }
                } else {
                    if (draftStale) Text("素材已更新，这份草稿可能过期，请重新核对。", color = ownwardColors.Warn)
                    OutlinedTextField(
                        value = content,
                        onValueChange = { content = it },
                        readOnly = !routineCanEdit(draftStatus),
                        enabled = !submitting,
                        label = { Text(if (routineCanEdit(draftStatus)) "草稿正文" else "正文（只读）") },
                        minLines = 8,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            }
        },
        confirmButton = {
            if (!loading && routineCanSubmit(draftStatus, loadedSuccessfully)) Row {
                TextButton(enabled = !submitting, onClick = {
                    submit({
                        client.routineSaveDraft(r.id, r.date, content)
                        draftStale = false
                    })
                }) { Text("保存") }
                TextButton(enabled = !submitting, onClick = {
                    submit({ saveThenWrite(
                        save = {
                            client.routineSaveDraft(r.id, r.date, content)
                            draftStale = false
                        },
                        write = { client.routineWrite(r.id, r.date) },
                    ) }, close = true)
                }) { Text("保存并写入") }
            }
        },
        dismissButton = { TextButton(enabled = !submitting, onClick = { reviewing = false }) { Text("关闭") } },
    )
}

@Composable
private fun ActionCard(
    a: Action,
    client: OwnwardClient,
    onOpenTask: (String) -> Unit,
    onOpenChat: (String) -> Unit,
    onChanged: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current
    val kindLabel = when (a.kind) {
        "reply" -> "回复"; "review" -> "评审"; "approve" -> "审批"
        "follow_up" -> "跟进"; "decide" -> "决策"; else -> a.kind
    }
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 3.dp),
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    kindLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.width(8.dp))
                Text(a.source, style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.weight(1f))
                if (a.state == "snoozed") Text("已暂缓", style = MaterialTheme.typography.labelSmall,
                    color = ownwardColors.Warn)
            }
            Spacer(Modifier.height(4.dp))
            Text(a.title, style = MaterialTheme.typography.bodyMedium)
            if (a.reason.isNotBlank()) Text(
                a.reason, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                a.ref.task_id?.let { id ->
                    TextButton(onClick = { onOpenTask(id) }) { Text("看任务") }
                }
                // lark 类 Action 的 chat_id 是飞书会话 id，不是 AI 对话——当对话打开只会 404
                a.ref.chat_id?.takeIf { a.source != "lark" }?.let { id ->
                    TextButton(onClick = { onOpenChat(id) }) { Text("看对话") }
                }
                a.ref.url?.takeIf { it.startsWith("http") }?.let { url ->
                    TextButton(onClick = { runCatching { uriHandler.openUri(url) } }) { Text("打开链接") }
                }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = {
                    scope.launch { runCatching { client.actionState(a.id, "resolved") }; onChanged() }
                }) { Text("完成", color = ownwardColors.Success) }
                TextButton(onClick = {
                    scope.launch { runCatching { client.actionState(a.id, "snoozed", 120) }; onChanged() }
                }) { Text("暂缓") }
                TextButton(onClick = {
                    scope.launch { runCatching { client.actionState(a.id, "dismissed") }; onChanged() }
                }) { Text("忽略", color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
    }
}
