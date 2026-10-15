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
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ai.ownward.app.data.AgentRole
import ai.ownward.app.data.ImageEncoder
import ai.ownward.app.data.FsDirListing
import ai.ownward.app.data.OutImage
import ai.ownward.app.data.OwnwardClient
import ai.ownward.app.data.ProjectDir
import ai.ownward.app.data.RoleCross
import ai.ownward.app.data.RolePreview
import ai.ownward.app.ui.theme.ownwardColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/** /api/work 只认这三个引擎（src/verticals.ts 白名单）；chat 的 codex-alt 之类第二账号键派任务不可用 */
private val ENGINES = listOf("claude" to "Claude", "codex" to "Codex", "codebuddy" to "CodeBuddy")

/** 服务端 chat.providers 没配该引擎时的兜底型号表（与 web/app.js 同一份） */
private val FALLBACK_MODELS = mapOf(
    "claude" to listOf("fable", "opus", "sonnet", "haiku"),
    "codex" to listOf("gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex-spark"),
    "codebuddy" to listOf("hy3", "hy3-x", "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5v-turbo", "minimax-m3-pay", "minimax-m2.7", "kimi-k3-2", "kimi-k2.7", "kimi-k2.6", "deepseek-v4-pro", "deepseek-v4-flash"),
)

private val WORK_PROVIDER_EFFORTS = mapOf(
    "claude" to listOf("low", "medium", "high", "xhigh", "max"),
    "codebuddy" to listOf("minimal", "low", "medium", "high", "xhigh", "max"),   // codebuddy --help 比 claude 多一档 minimal
)

internal val WORK_CODEX_MODEL_EFFORTS = linkedMapOf(
    "gpt-6-astra" to listOf("low", "medium", "high", "xhigh", "max", "ultra"),
    "gpt-5.6-sol" to listOf("low", "medium", "high", "xhigh", "max", "ultra"),
    "gpt-5.6-terra" to listOf("low", "medium", "high", "xhigh", "max", "ultra"),
    "gpt-5.6-luna" to listOf("low", "medium", "high", "xhigh", "max"),
    "gpt-5.5" to listOf("low", "medium", "high", "xhigh"),
    "gpt-5.3-codex-spark" to listOf("low", "medium", "high", "xhigh"),
)

internal fun workProviderDefaultModel(provider: String): String =
    if (provider == "codex") "gpt-5.6-sol" else ""

internal fun workProviderHandoffModel(provider: String): String = when (provider) {
    "codex" -> "gpt-5.6-sol"
    "codebuddy" -> "hy3"
    else -> "sonnet"
}

internal fun workProviderModels(provider: String, providers: Map<String, List<String>>): List<String> =
    if (provider == "codex") FALLBACK_MODELS[provider].orEmpty()
    else (providers[provider].orEmpty() + FALLBACK_MODELS[provider].orEmpty()).distinct()

internal fun workProviderEfforts(provider: String, model: String): List<String> =
    if (provider == "codex") WORK_CODEX_MODEL_EFFORTS[model.ifBlank { workProviderDefaultModel(provider) }].orEmpty()
    else WORK_PROVIDER_EFFORTS[provider].orEmpty()

internal fun workProviderDefaultEffort(provider: String, model: String): String =
    workProviderEfforts(provider, model).let { if ("medium" in it) "medium" else it.firstOrNull().orEmpty() }

internal fun workProviderSelectionIsValid(
    provider: String,
    model: String,
    effort: String,
    allowOmitted: Boolean = false,
): Boolean {
    if (!allowOmitted && (model.isBlank() || effort.isBlank())) return false
    val effectiveModel = model.ifBlank { workProviderDefaultModel(provider) }
    val modelValid = model.isBlank() || provider != "codex" || effectiveModel in WORK_CODEX_MODEL_EFFORTS
    val effortValid = effort.isBlank() || effort in workProviderEfforts(provider, effectiveModel)
    return modelValid && effortValid
}

internal fun normalizedDispatchDefaultEffort(provider: String, model: String, configured: String?): String = when {
    configured.isNullOrEmpty() -> ""
    configured in workProviderEfforts(provider, model) -> configured
    else -> workProviderDefaultEffort(provider, model)
}

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
 *
 * 谁来接（src/role-auto.ts）：缺省「自动」——按目录匹配这个仓库的项目 Owner，没有就在派发时建；
 * 也可以点名一个角色（它登记的工作目录直接填好）或不用角色。跨了几个项目又没有角色同时管时，
 * 问一句要不要建跨项目角色。主目录不是仓库时按任务描述匹配领域角色，拿不准就摆出候选让人手选
 * （没手选不许提交）；匹配上了就点名发它——预览给人看的是谁，派出去就是谁，不交给服务端重判。
 * 规则在 Roles.kt（与 web / iOS 同一张预期表）。
 * initialRole：角色页「派任务给它」点名进来的角色 id。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DispatchScreen(client: OwnwardClient, onBack: () -> Unit, onDispatched: (String) -> Unit, initialRole: String? = null) {
    var projects by remember { mutableStateOf<List<ProjectDir>>(emptyList()) }
    var providers by remember { mutableStateOf(mapOf<String, List<String>>()) }
    var allowFullAccess by remember { mutableStateOf(false) }
    var dir by rememberSaveable { mutableStateOf("") }
    var task by rememberSaveable { mutableStateOf("") }
    var provider by rememberSaveable { mutableStateOf("claude") }
    var model by rememberSaveable { mutableStateOf("") }          // "" = 引擎默认
    var effort by rememberSaveable { mutableStateOf("") }         // "" = Provider 默认
    var permission by rememberSaveable { mutableStateOf("safe") } // safe | bypass
    var worktree by rememberSaveable { mutableStateOf(true) }
    var defaultsApplied by rememberSaveable { mutableStateOf(false) } // 旋转/返回不重复覆盖用户已改的值
    var pendingImages by remember { mutableStateOf<List<Pair<Uri, OutImage>>>(emptyList()) }
    var modelMenu by remember { mutableStateOf(false) }
    var effortMenu by remember { mutableStateOf(false) }
    var browsing by remember { mutableStateOf(false) }
    var submitting by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // ---- 谁来接 ----
    var roles by remember { mutableStateOf<List<AgentRole>>(emptyList()) }
    var rolesSupported by remember { mutableStateOf(false) }      // 服务端声明 /api/work 收 role 键才画这一节
    var roleChoice by rememberSaveable { mutableStateOf(initialRole ?: ROLE_AUTO) }
    var initialRoleApplied by rememberSaveable { mutableStateOf(false) }
    var roleMenu by remember { mutableStateOf(false) }
    var extraDirs by rememberSaveable { mutableStateOf(listOf<String>()) }
    var browsingExtra by remember { mutableStateOf(false) }
    var preview by remember { mutableStateOf<RolePreview?>(null) }
    var previewError by remember { mutableStateOf<String?>(null) }
    var byTask by remember { mutableStateOf(false) }        // 上一次预览是不是 by=task（重新预览清空期间仍是 true：提交要拦的就是这段）
    var previewTask by remember { mutableStateOf("") }      // 最近一次完成的预览请求带的描述（发请求那一刻的，trim 后）
    var previewKick by remember { mutableStateOf(0) }       // 提交被「还在匹配」拦下就 +1：立刻重新预览，不等 800ms 防抖
    var crossSkipped by remember { mutableStateOf(setOf<String>()) }
    var creatingCross by remember { mutableStateOf(false) }
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
                model = d.model?.takeIf { it.isNotBlank() } ?: workProviderDefaultModel(provider)
                effort = normalizedDispatchDefaultEffort(provider, model, d.effort)
                if (d.permission == "safe" || (d.permission == "bypass" && s.allowFullAccess)) permission = d.permission
                defaultsApplied = true
            }
            // 服务端没开全权限时 bypass 不可选（与 web 的双门一致）
            if (permission == "bypass" && !s.allowFullAccess) permission = "safe"
        }.onFailure { error = it.message }
        // 角色放在默认值之后：点名的角色带着自己的工作目录，要盖过 dispatch.defaults.dir
        runCatching { client.roles() }.onSuccess { r ->
            roles = r.roles
            rolesSupported = r.ok && r.dispatchRole
            if (!rolesSupported) roleChoice = ROLE_AUTO
            if (rolesSupported && initialRole != null && !initialRoleApplied) {
                val role = r.roles.firstOrNull { it.id == initialRole }
                if (role == null) { roleChoice = ROLE_AUTO; error = "这个角色读不到了（可能刚被归档）" }
                else roleDirs(role)?.let { (d, extras) -> dir = d; extraDirs = extras }
                initialRoleApplied = true
            }
        }
    }

    // 「自动」会落到谁、是不是跨项目：目录一变就重新问（LaunchedEffect 换 key 会取消上一次，天然防抖）。
    // 预览总带上当前任务描述：主目录不是仓库时服务端按描述匹配领域角色（by=task，要调一次模型）。
    // 所以描述变了，只有上一次预览是 by=task 才重新问，防抖 800ms；byTask 跟着这组目录走，目录一变就复位
    LaunchedEffect(dir, extraDirs, rolesSupported) {
        preview = null
        previewError = null
        byTask = false
        previewTask = ""
        val d = dir.trim()
        if (!rolesSupported || d.isBlank()) return@LaunchedEffect
        val extras = extraDirs.filter { it != d }
        var asked: String? = null     // 眼下这份预览（或错误）是按哪段描述问的；null = 还没问出来
        suspend fun ask(t: String) {
            preview = null
            previewError = null
            asked = null
            try {
                val p = client.resolveRoles(d, extras, t)
                preview = p
                byTask = previewByTask(p)
                previewTask = t   // 记发请求那一刻的描述：请求在路上时人又改了描述，也不会被新输入盖掉
            } catch (e: CancellationException) {
                throw e   // 目录或描述又变了、这一轮被取消：别把「…was cancelled」当错误写进提示（新一轮会重新问）
            } catch (e: Exception) {
                previewError = e.message ?: "匹配角色失败"
            }
            asked = t
        }
        delay(400)   // 手输目录时别每敲一个字都问一次
        ask(task.trim())
        // 描述又变了（或提交被「还在匹配」拦下、要立刻重问）：collectLatest 会取消还没回来的上一轮（连同它的防抖），只认最后一次
        var kicked = previewKick
        snapshotFlow { task.trim() to previewKick }.collectLatest { (t, kick) ->
            val now = kick != kicked
            kicked = kick
            if (!byTask || (t == asked && !now)) return@collectLatest
            if (!now) delay(800)   // 改描述要服务端调一次模型：别每敲一个字都问
            ask(t)
        }
    }

    fun pickRole(choice: String) {
        roleChoice = choice
        roleMenu = false
        if (error == ROLE_PICK_REQUIRED || error == ROLE_MATCHING_MSG) error = null   // 被拦下后已经手选了：那句提示不再成立
        val role = roles.firstOrNull { it.id == choice } ?: return
        // 领域角色不绑目录（它登记的一般就是 ~/workspace）：主目录已经填了就不动，空着才替人填
        if (role.origin == "domain" && dir.isNotBlank()) return
        // 点名一个角色：它登记了工作目录就替人填好（第一个当主目录，其余当附加目录）——派给角色，不用再找目录
        roleDirs(role)?.let { (d, extras) -> dir = d; extraDirs = extras }
    }

    fun createCross(cross: RoleCross) {
        if (creatingCross) return
        creatingCross = true
        scope.launch {
            try {
                val r = client.createCrossRole(cross.dirs)
                val role = r.role
                if (!r.ok || role == null) {
                    error = r.msg.ifBlank { "没建成" }
                    return@launch
                }
                runCatching { client.roles() }.onSuccess { roles = it.roles }
                roleChoice = role.id
            } catch (e: Exception) {
                error = e.message
            } finally {
                creatingCross = false
            }
        }
    }

    val models = workProviderModels(provider, providers)
    val efforts = workProviderEfforts(provider, model)

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
        if (effort.isNotBlank() && effort !in workProviderEfforts(provider, model)) {
            error = "所选模型不支持这个思考深度"; return
        }
        // 派出去的角色 = 预览给人看的角色：按描述匹配时点名发预览里的那个；拿不准 / 新描述的预览还没回来就先拦下
        val role = when (val s = roleSubmit(roleChoice, preview, byTask, previewTask, task.trim(), rolesSupported)) {
            is RoleSubmit.Block -> {
                error = s.msg
                if (s.msg == ROLE_MATCHING_MSG) previewKick++   // 别等 800ms 防抖，立刻按现在的描述重问
                return
            }
            is RoleSubmit.Send -> s.role
        }
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
                    effort = effort.ifBlank { null },
                    permission = permission,
                    images = pendingImages.map { it.second },
                    role = role,
                    extraDirs = extraDirs.filter { it != d },
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

            // 附加目录：agent 能同时读写这几个仓库；跨项目时下面「角色」一节会问要不要建跨项目角色
            if (extraDirs.isNotEmpty()) Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                extraDirs.forEach { x ->
                    FilterChip(
                        selected = true,
                        onClick = { extraDirs = extraDirs - x },
                        label = { Text(x.trimEnd('/').substringAfterLast('/').ifBlank { x }) },
                        trailingIcon = { Icon(Icons.Filled.Close, "移除附加目录", modifier = Modifier.size(16.dp)) },
                    )
                }
            }
            TextButton(onClick = { browsingExtra = true }) { Text("添加附加目录") }

            if (rolesSupported) {
                Spacer(Modifier.height(12.dp))
                SectionHeader("角色")
                Box {
                    Surface(
                        shape = MaterialTheme.shapes.medium,
                        color = MaterialTheme.colorScheme.surface,
                        modifier = Modifier.fillMaxWidth().clickable { roleMenu = true },
                    ) {
                        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("谁来接", style = MaterialTheme.typography.bodyMedium)
                            Spacer(Modifier.weight(1f))
                            Text(
                                roleChoiceLabel(roleChoice, roles),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.primary,
                                maxLines = 1,
                            )
                            Icon(Icons.Filled.ArrowDropDown, null, tint = ownwardColors.TextDim, modifier = Modifier.size(20.dp))
                        }
                    }
                    DropdownMenu(expanded = roleMenu, onDismissRequest = { roleMenu = false }) {
                        val groups = dispatchableRoles(roles)
                        DropdownMenuItem(text = { Text("自动匹配（推荐）") }, onClick = { pickRole(ROLE_AUTO) })
                        groups.projects.forEach { r -> RoleMenuItem(r) { pickRole(r.id) } }
                        // 领域角色单独一组、夹在项目角色和跨项目角色之间：上下各一道分隔线，免得后面的跨项目角色看着也归这组
                        if (groups.domains.isNotEmpty()) {
                            HorizontalDivider()
                            Text(
                                "领域角色",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                            )
                            groups.domains.forEach { r -> RoleMenuItem(r) { pickRole(r.id) } }
                            HorizontalDivider()
                        }
                        groups.cross.forEach { r -> RoleMenuItem(r) { pickRole(r.id) } }
                        DropdownMenuItem(text = { Text("不用角色") }, onClick = { pickRole(ROLE_NONE) })
                    }
                }
                val hint = roleHint(roleChoice, preview, roles, dir.isBlank())
                Text(
                    previewError ?: hint.text,
                    style = MaterialTheme.typography.bodySmall,
                    color = when {
                        previewError != null || hint.tone == HintTone.Warn -> MaterialTheme.colorScheme.error
                        hint.tone == HintTone.New -> MaterialTheme.colorScheme.primary
                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    modifier = Modifier.padding(top = 6.dp, start = 4.dp),
                )
                // 拿不准由哪个领域角色接：候选摆成一排让人手选（点了就是点名它），或者干脆不用角色
                val candidates = rolePickCandidates(roleChoice, preview)
                if (candidates.isNotEmpty()) Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    candidates.forEach { c ->
                        FilterChip(selected = false, onClick = { pickRole(c.id) }, label = { Text(c.name.ifBlank { c.id }) })
                    }
                    FilterChip(selected = false, onClick = { pickRole(ROLE_NONE) }, label = { Text("不用角色") })
                }
                crossPrompt(roleChoice, preview, crossSkipped)?.let { cross ->
                    Surface(
                        shape = MaterialTheme.shapes.medium,
                        color = MaterialTheme.colorScheme.primary.copy(alpha = 0.10f),
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    ) {
                        Column(Modifier.padding(12.dp)) {
                            Text(crossPromptText(cross), style = MaterialTheme.typography.bodySmall)
                            if (cross.possible) Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(onClick = { createCross(cross) }, enabled = !creatingCross) { Text("建「${cross.name}」并由它接手") }
                                TextButton(onClick = { crossSkipped = crossSkipped + crossKey(cross) }) { Text("不用") }
                            }
                        }
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
                            if (provider != key) {
                                provider = key
                                model = workProviderDefaultModel(key)
                                effort = workProviderDefaultEffort(key, model)
                            }
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
                    modifier = Modifier.fillMaxWidth().clickable { effortMenu = true },
                ) {
                    Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("思考深度", style = MaterialTheme.typography.bodyMedium)
                        Spacer(Modifier.weight(1f))
                        Text(
                            effort.ifBlank { "默认" },
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.primary,
                        )
                        Icon(Icons.Filled.ArrowDropDown, null, tint = ownwardColors.TextDim, modifier = Modifier.size(20.dp))
                    }
                }
                DropdownMenu(expanded = effortMenu, onDismissRequest = { effortMenu = false }) {
                    DropdownMenuItem(text = { Text("默认") }, onClick = { effort = ""; effortMenu = false })
                    efforts.forEach { item ->
                        DropdownMenuItem(text = { Text(item) }, onClick = { effort = item; effortMenu = false })
                    }
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
                    DropdownMenuItem(text = { Text("默认") }, onClick = {
                        model = ""
                        effort = effort.takeIf { it in workProviderEfforts(provider, model) } ?: workProviderDefaultEffort(provider, model)
                        modelMenu = false
                    })
                    models.forEach { m ->
                        DropdownMenuItem(text = { Text(m) }, onClick = {
                            model = m
                            effort = effort.takeIf { it in workProviderEfforts(provider, model) } ?: workProviderDefaultEffort(provider, model)
                            modelMenu = false
                        })
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
    if (browsingExtra) DirectoryPicker(
        client = client,
        startPath = dir.trim().ifBlank { null },
        onDismiss = { browsingExtra = false },
        onPick = { picked ->
            if (picked == dir.trim()) error = "附加目录不能和主目录相同"
            else if (picked !in extraDirs) extraDirs = extraDirs + picked
            browsingExtra = false
        },
    )
}

/** 角色下拉的一项：名字 + 叫法（项目 Owner / 领域角色 / 跨项目角色…） */
@Composable
private fun RoleMenuItem(role: AgentRole, onClick: () -> Unit) {
    DropdownMenuItem(
        text = {
            Column {
                Text(role.name.ifBlank { role.id }, maxLines = 1)
                Text(roleKindLabel(role), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        onClick = onClick,
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
