package ai.ownward.app.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ai.ownward.app.data.ImageEncoder
import ai.ownward.app.data.FsDirListing
import ai.ownward.app.data.OutImage
import ai.ownward.app.data.OwnwardClient
import ai.ownward.app.data.ProjectDir
import ai.ownward.app.ui.theme.ownwardColors
import kotlinx.coroutines.launch

/** /api/work 只认这三个引擎（src/verticals.ts 白名单）；chat 的 codex-alt 之类第二账号键派任务不可用 */
private val ENGINES = listOf("claude" to "Claude", "codex" to "Codex", "codebuddy" to "CodeBuddy")

/** 服务端 chat.providers 没配该引擎时的兜底型号表（与 web/app.js 同一份） */
private val FALLBACK_MODELS = mapOf(
    "claude" to listOf("opus", "sonnet", "haiku"),
    "codex" to listOf("gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.5", "gpt-5.5-pro"),
    "codebuddy" to listOf("hy3", "glm-5.2", "kimi-k3-1", "minimax-m3", "deepseek-v4-pro", "deepseek-v3-2-volc"),
)

internal data class DirPickerNav(
    val requestedPath: String?,
    val canFallbackToRoots: Boolean = true,
) {
    fun loaded() = copy(canFallbackToRoots = false)
    fun failed(): DirPickerNav? =
        if (canFallbackToRoots && requestedPath != null) DirPickerNav(null, false) else null
    fun go(path: String?) = DirPickerNav(path, false)
}

/** 描述留空时的开场白（与 web 同款）：开一个「待命会话」，进会话再说要干啥 */
private const val STANDBY_PROMPT = "你是常驻结对助手。本条只是开场，简短确认待命即可，等我下一条消息再开始干活。"

/**
 * 派新任务（web「派任务」弹窗的手机版）。
 * 固定 bg=true：手机上没有 terminal 通道（terminal 模式会在 daemon 那台机器上弹终端）。
 * 默认值由服务端下发（state.dispatchDefaults），候选目录来自 /api/projects，
 * 型号表复用 /api/chat/providers（同一台机器能用的模型是同一批，不另维护）。
 * 派发成功直接进会话（onDispatched），不停在列表。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DispatchScreen(client: OwnwardClient, onBack: () -> Unit, onDispatched: (String) -> Unit) {
    var projects by remember { mutableStateOf<List<ProjectDir>>(emptyList()) }
    var providers by remember { mutableStateOf(mapOf<String, List<String>>()) }
    var allowFullAccess by remember { mutableStateOf(false) }
    var dir by rememberSaveable { mutableStateOf("") }
    var task by rememberSaveable { mutableStateOf("") }
    var provider by rememberSaveable { mutableStateOf("claude") }
    var model by rememberSaveable { mutableStateOf("") }          // "" = 引擎默认
    var permission by rememberSaveable { mutableStateOf("safe") } // safe | bypass
    var worktree by rememberSaveable { mutableStateOf(true) }
    var defaultsApplied by rememberSaveable { mutableStateOf(false) } // 旋转/返回不重复覆盖用户已改的值
    var pendingImages by remember { mutableStateOf<List<Pair<Uri, OutImage>>>(emptyList()) }
    var modelMenu by remember { mutableStateOf(false) }
    var browsing by remember { mutableStateOf(false) }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    LaunchedEffect(Unit) {
        runCatching { client.projects() }.onSuccess { projects = it }
        runCatching { client.chatProviders() }.onSuccess { providers = it }
        runCatching { client.state() }.onSuccess { s ->
            allowFullAccess = s.allowFullAccess
            val d = s.dispatchDefaults
            if (!defaultsApplied) {
                if (dir.isBlank() && !d.dir.isNullOrBlank()) dir = d.dir
                when {
                    d.provider != null && ENGINES.any { it.first == d.provider } -> provider = d.provider
                    d.codex != null -> provider = if (d.codex) "codex" else "claude"
                }
                if (!d.model.isNullOrBlank()) model = d.model
                if (d.permission == "safe" || (d.permission == "bypass" && s.allowFullAccess)) permission = d.permission
                defaultsApplied = true
            }
            // 服务端没开全权限时 bypass 不可选（与 web 的双门一致）
            if (permission == "bypass" && !s.allowFullAccess) permission = "safe"
        }.onFailure { error = it.message }
    }

    val models = providers[provider]?.takeIf { it.isNotEmpty() } ?: FALLBACK_MODELS[provider].orEmpty()

    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(ImageEncoder.MAX_IMAGES)
    ) { uris ->
        scope.launch {
            val encoded = uris.mapNotNull { uri -> ImageEncoder.fromUri(context, uri)?.let { uri to it } }
            pendingImages = (pendingImages + encoded).take(ImageEncoder.MAX_IMAGES)
            if (encoded.size < uris.size) error = "部分图片读取失败或超过 5MB"
        }
    }

    fun submit() {
        val d = dir.trim()
        if (d.isBlank()) { error = "先选项目目录"; return }
        if (submitting) return
        submitting = true
        error = null
        scope.launch {
            try {
                val r = client.dispatchWork(
                    dir = d,
                    task = task.trim().ifBlank { STANDBY_PROMPT },
                    provider = provider,
                    worktree = worktree,
                    model = model.ifBlank { null },
                    permission = permission,
                    images = pendingImages.map { it.second },
                )
                if (!r.ok) error = r.msg.ifBlank { "派发失败" }
                else {
                    val id = r.taskId()
                    if (id != null) onDispatched(id) else onBack()
                }
            } catch (e: Exception) {
                error = e.message
            } finally {
                submitting = false
            }
        }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            Column(Modifier.glassBar()) {
                TopAppBar(
                    title = { Text("新任务", fontWeight = FontWeight.Bold) },
                    navigationIcon = {
                        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                )
                ErrorBanner(error)
            }
        },
        bottomBar = {
            Box(
                Modifier
                    .fillMaxWidth()
                    .glassBar()
                    .navigationBarsPadding()
                    .imePadding()
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            ) {
                Button(
                    onClick = ::submit,
                    enabled = !submitting && dir.isNotBlank(),
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) {
                    if (submitting) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                    else Text(if (task.isBlank()) "开待命会话" else "派发任务")
                }
            }
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .hazeContent()
                .verticalScroll(rememberScrollState())
                .padding(top = padding.calculateTopPadding(), bottom = padding.calculateBottomPadding())
                .padding(horizontal = 16.dp),
        ) {
            Spacer(Modifier.height(4.dp))
            SectionHeader("项目目录")
            OutlinedTextField(
                value = dir, onValueChange = { dir = it },
                placeholder = { Text("~/workspace/项目", color = ownwardColors.TextDim) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            TextButton(onClick = { browsing = true }) { Text("浏览远程目录") }
            if (projects.isNotEmpty()) {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    projects.forEach { p ->
                        FilterChip(
                            selected = dir.trim() == p.dir,
                            onClick = { dir = p.dir },
                            label = { Text(p.name.ifBlank { p.dir }) },
                        )
                    }
                }
            }

            Spacer(Modifier.height(12.dp))
            SectionHeader("引擎")
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                ENGINES.forEachIndexed { i, (key, label) ->
                    SegmentedButton(
                        selected = provider == key,
                        onClick = {
                            if (provider != key) { provider = key; model = "" } // 型号表随引擎切换，旧值不跨引擎
                        },
                        shape = SegmentedButtonDefaults.itemShape(index = i, count = ENGINES.size),
                        label = { Text(label) },
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
            Box {
                Surface(
                    shape = MaterialTheme.shapes.medium,
                    color = MaterialTheme.colorScheme.surface,
                    modifier = Modifier.fillMaxWidth().clickable { modelMenu = true },
                ) {
                    Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("模型", style = MaterialTheme.typography.bodyMedium)
                        Spacer(Modifier.weight(1f))
                        Text(
                            model.ifBlank { "默认" },
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Icon(Icons.Filled.ArrowDropDown, null, tint = ownwardColors.TextDim, modifier = Modifier.size(20.dp))
                    }
                }
                DropdownMenu(expanded = modelMenu, onDismissRequest = { modelMenu = false }) {
                    DropdownMenuItem(text = { Text("默认") }, onClick = { model = ""; modelMenu = false })
                    models.forEach { m ->
                        DropdownMenuItem(text = { Text(m) }, onClick = { model = m; modelMenu = false })
                    }
                }
            }

            Spacer(Modifier.height(12.dp))
            SectionHeader("权限")
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                SegmentedButton(
                    selected = permission == "safe",
                    onClick = { permission = "safe" },
                    shape = SegmentedButtonDefaults.itemShape(index = 0, count = 2),
                    label = { Text("高危命令审批") },
                )
                SegmentedButton(
                    selected = permission == "bypass",
                    onClick = { permission = "bypass" },
                    enabled = allowFullAccess,
                    shape = SegmentedButtonDefaults.itemShape(index = 1, count = 2),
                    label = { Text("全放行") },
                )
            }
            if (!allowFullAccess) Text(
                "服务端未开启 architecture.allowFullAccess，全放行不可选",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 6.dp, start = 4.dp),
            )
            Spacer(Modifier.height(8.dp))
            Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
                Row(Modifier.padding(start = 14.dp, end = 8.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("隔离 worktree", style = MaterialTheme.typography.bodyMedium)
                        Text(
                            "在独立分支/目录里干活，不碰主检出",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(checked = worktree, onCheckedChange = { worktree = it })
                }
            }

            Spacer(Modifier.height(12.dp))
            SectionHeader("任务描述")
            OutlinedTextField(
                value = task, onValueChange = { task = it },
                placeholder = { Text("要做什么？留空=先开一个待命会话，进会话再说", color = ownwardColors.TextDim) },
                minLines = 4, maxLines = 12,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                pendingImages.forEach { (uri, _) ->
                    Box {
                        coil.compose.AsyncImage(
                            model = uri, contentDescription = null,
                            modifier = Modifier
                                .size(64.dp)
                                .clip(RoundedCornerShape(12.dp))
                                .background(ownwardColors.Surface2),
                        )
                        IconButton(
                            onClick = { pendingImages = pendingImages.filterNot { it.first == uri } },
                            modifier = Modifier.size(20.dp).align(Alignment.TopEnd),
                        ) { Icon(Icons.Filled.Close, "移除", modifier = Modifier.size(12.dp)) }
                    }
                }
                if (pendingImages.size < ImageEncoder.MAX_IMAGES) Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = ownwardColors.Surface2,
                    modifier = Modifier.size(64.dp).clickable {
                        picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                    },
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(Icons.Filled.Add, "附图", tint = ownwardColors.TextDim)
                    }
                }
                Text(
                    if (pendingImages.isEmpty()) "附图（可选）" else "${pendingImages.size} 张",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(24.dp))
        }
    }

    if (browsing) DirectoryPicker(
        client = client,
        startPath = dir.trim().ifBlank { null },
        onDismiss = { browsing = false },
        onPick = { dir = it; browsing = false },
    )
}

/** 与网页目录选择器共用 /api/fs/dirs：根视图不能选，进入授权根后可选当前目录。 */
@Composable
private fun DirectoryPicker(
    client: OwnwardClient,
    startPath: String?,
    onDismiss: () -> Unit,
    onPick: (String) -> Unit,
) {
    var listing by remember { mutableStateOf<FsDirListing?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var nav by remember { mutableStateOf(DirPickerNav(startPath)) }

    LaunchedEffect(nav.requestedPath) {
        loading = true
        error = null
        try {
            listing = client.fsDirs(nav.requestedPath)
            nav = nav.loaded()
        } catch (e: Exception) {
            // 手输值可能含 ~ 或已失效：首次打开和网页一致，自动退回授权根视图。
            val retry = nav.failed()
            if (retry != null) {
                nav = retry
                return@LaunchedEffect
            }
            error = e.message ?: "目录载入失败"
        } finally {
            loading = false
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("选择项目目录") },
        text = {
            Column {
                Text(
                    listing?.path ?: "授权根目录",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                )
                Spacer(Modifier.height(8.dp))
                when {
                    loading -> Box(Modifier.fillMaxWidth().height(120.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                    }
                    error != null -> Text(error!!, color = MaterialTheme.colorScheme.error)
                    else -> LazyColumn(Modifier.fillMaxWidth().heightIn(max = 360.dp)) {
                        val entries = listing?.entries.orEmpty()
                        if (entries.isEmpty()) item {
                            Text(
                                "没有子目录，可选择当前目录",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(vertical = 16.dp),
                            )
                        }
                        items(entries.size, key = { entries[it].path }) { i ->
                            val entry = entries[i]
                            Row(
                                Modifier.fillMaxWidth().clickable { nav = nav.go(entry.path) }
                                    .padding(vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text("📁", modifier = Modifier.padding(end = 8.dp))
                                Text(entry.name, modifier = Modifier.weight(1f), maxLines = 1)
                                if (entry.git) Text(
                                    "git",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.primary,
                                    modifier = Modifier.padding(horizontal = 8.dp),
                                )
                                TextButton(onClick = { onPick(entry.path) }) { Text("选择") }
                            }
                        }
                        if (listing?.truncated == true) item {
                            Text(
                                "目录太多，只显示前 300 个；可继续下钻或手输路径",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                                modifier = Modifier.padding(vertical = 8.dp),
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !loading && error == null && listing?.path != null,
                onClick = { listing?.path?.let(onPick) },
            ) { Text("选择此目录") }
        },
        dismissButton = {
            Row {
                TextButton(
                    enabled = !loading && error == null && listing != null && listing?.path != null,
                    onClick = { nav = nav.go(listing?.parent) },
                ) { Text("返回上级") }
                TextButton(onClick = onDismiss) { Text("取消") }
            }
        },
    )
}
