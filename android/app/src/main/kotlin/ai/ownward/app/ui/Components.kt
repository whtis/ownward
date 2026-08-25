package ai.ownward.app.ui

import android.net.Uri
import android.os.Build
import android.widget.Toast
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.heightIn
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import ai.ownward.app.data.OwnwardClient
import ai.ownward.app.data.DevMsg
import ai.ownward.app.data.OutImage
import ai.ownward.app.data.PendingPerm
import ai.ownward.app.data.PlanStep
import ai.ownward.app.data.QueuedView
import ai.ownward.app.ui.theme.ownwardColors
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * 生命周期感知轮询：仅前台（STARTED）时运行，离开页面自动取消。
 * intervalMs 由调用方每轮返回，便于「运行中 2.5s / 空闲 10s」的动态节奏。
 */
@Composable
fun Poller(key: Any?, tick: suspend () -> Long) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val latest by rememberUpdatedState(tick)
    LaunchedEffect(key, lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                val interval = try {
                    latest()
                } catch (e: Exception) {
                    8000L // 失败退避
                }
                delay(interval)
            }
        }
    }
}

/** ISO 时间串（服务端 toISOString / +08:00 偏移都可能出现）→ 相对时间 */
fun timeAgoIso(iso: String): String = runCatching {
    timeAgo(java.time.OffsetDateTime.parse(iso).toInstant().toEpochMilli())
}.getOrElse {
    runCatching { timeAgo(java.time.Instant.parse(iso).toEpochMilli()) }.getOrDefault("")
}

fun timeAgo(epochMs: Long): String {
    if (epochMs <= 0) return ""
    val diff = (System.currentTimeMillis() - epochMs) / 1000
    return when {
        diff < 60 -> "刚刚"
        diff < 3600 -> "${diff / 60} 分钟前"
        diff < 86400 -> "${diff / 3600} 小时前"
        else -> "${diff / 86400} 天前"
    }
}

@Composable
fun StatusDot(color: Color, modifier: Modifier = Modifier) {
    Box(modifier.size(8.dp).background(color, CircleShape))
}

@Composable
fun SectionHeader(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

// ---- 搜索与列表行（侧边栏与任务页共用，两处口径/样式不会各走各的）----

/** 搜索命中：空查询全放行；任一字段包含即命中（忽略大小写） */
fun searchHit(query: String, vararg fields: String?): Boolean {
    val q = query.trim()
    return q.isEmpty() || fields.any { it?.contains(q, ignoreCase = true) == true }
}

/** 新 daemon 给真实 provider；老 daemon 回退到 mode。 */
fun engineLabel(mode: String, backend: String? = null, providerId: String? = null): String =
    providerId?.takeIf { it.isNotBlank() }
        ?: backend?.takeIf { it.isNotBlank() }
        ?: when {
            mode.startsWith("codex") -> "codex"
            mode.startsWith("codebuddy") -> "codebuddy"
            else -> "claude"
        }

/** 列表行副标题：「项目 · 引擎 · 时间」，空段自动省略 */
fun sessionSub(vararg parts: String): String = parts.filter { it.isNotBlank() }.joinToString(" · ")

/** 圆形图标钮（顶栏「搜索」等） */
@Composable
fun RoundIconButton(icon: ImageVector, desc: String, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.size(40.dp),
    ) {
        Box(contentAlignment = Alignment.Center) { Icon(icon, desc, modifier = Modifier.size(20.dp)) }
    }
}

/** 药丸搜索框：原位替换标题（ChatGPT 同款）。展开即抢焦点弹键盘，X 关闭并清空 */
@Composable
fun SearchField(
    value: String,
    onValueChange: (String) -> Unit,
    onClose: () -> Unit,
    placeholder: String = "搜索任务、会话、对话",
    modifier: Modifier = Modifier,
) {
    val focus = remember { FocusRequester() }
    Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surfaceVariant, modifier = modifier.height(44.dp)) {
        Row(Modifier.padding(start = 14.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Search, null, tint = ownwardColors.TextDim, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = ownwardColors.Text),
                    cursorBrush = SolidColor(ownwardColors.Accent),
                    modifier = Modifier.fillMaxWidth().focusRequester(focus),
                )
                if (value.isEmpty()) Text(
                    placeholder,
                    style = MaterialTheme.typography.bodyLarge,
                    color = ownwardColors.TextDim,
                )
            }
            IconButton(onClick = onClose, modifier = Modifier.size(36.dp)) {
                Icon(Icons.Filled.Close, "关闭搜索", modifier = Modifier.size(18.dp))
            }
        }
    }
    LaunchedEffect(Unit) { focus.requestFocus() }
}

/**
 * 列表行：状态点 + 标题一行 + 「项目 · 引擎 · 时间」一行。
 * 紧凑（两行 ~52dp）是刻意的——任务/会话动辄上百条，卡片式三行的列表滚不到底。
 */
@Composable
fun EntityRow(
    title: String,
    sub: String,
    dot: Color? = null,
    selected: Boolean = false,
    trailing: (@Composable () -> Unit)? = null, // 行尾动作（如列表页的删除钮）；抽屉里不给
    onClick: () -> Unit,
) {
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = if (selected) MaterialTheme.colorScheme.surfaceContainerHighest else Color.Transparent,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 1.dp).clickable(onClick = onClick),
    ) {
        Row(
            Modifier.padding(start = 12.dp, end = if (trailing == null) 12.dp else 4.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (dot != null) {
                StatusDot(dot)
                Spacer(Modifier.width(10.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (sub.isNotBlank()) Text(
                    sub, style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            trailing?.invoke()
        }
    }
}

// ---- 长按复制 ----

/**
 * 长按复制整条消息。流式输出途中同样可用——复制的是当前已经吐出来的那部分，
 * 所以 text 传 lambda（每次长按现取），不能在组合时把字符串定死。
 *
 * 用 combinedClickable 而不是 detectTapGestures：前者是列表里的标准手势，
 * 与 LazyColumn 的滚动判定协作正确（后者会吃掉 down 事件，按住再滑动就滚不动了）。
 * indication = null：点一下不该有涟漪（点击本身不做事），反馈交给震动 + 系统剪贴板提示。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun copyOnLongPress(
    onClick: () -> Unit = {},
    indicate: Boolean = false,
    text: () -> String,
): Modifier {
    val clipboard = LocalClipboardManager.current
    val haptics = LocalHapticFeedback.current
    val context = LocalContext.current
    val latest by rememberUpdatedState(text)
    val onTap by rememberUpdatedState(onClick)
    val interaction = remember { MutableInteractionSource() }
    return Modifier.combinedClickable(
        interactionSource = interaction,
        indication = if (indicate) LocalIndication.current else null,
        onClick = { onTap() },
        onLongClickLabel = "复制",
        onLongClick = {
            val t = latest().trim()
            if (t.isNotEmpty()) {
                clipboard.setText(AnnotatedString(t))
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                // Android 13+ 系统自带剪贴板提示条，再弹 Toast 就是两条重复反馈
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                    Toast.makeText(context, "已复制", Toast.LENGTH_SHORT).show()
                }
            }
        },
    )
}

@Composable
fun ErrorBanner(msg: String?) {
    if (msg.isNullOrBlank()) return
    Surface(
        color = ownwardColors.Danger.copy(alpha = 0.15f),
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
    ) {
        Text(
            msg,
            color = ownwardColors.Danger,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(10.dp),
        )
    }
}

// ---- AskUserQuestion 解析（结构见 web/tasks.js 权限卡分支）----

data class AskOption(val label: String, val description: String)
data class AskQuestion(val question: String, val options: List<AskOption>, val multiSelect: Boolean)

fun parseAskQuestion(perm: PendingPerm): AskQuestion? {
    if (perm.toolName != "AskUserQuestion") return null
    return runCatching {
        val q = (perm.input as? JsonObject)?.get("questions")?.jsonArray?.firstOrNull()?.jsonObject
            ?: return null
        AskQuestion(
            question = q["question"]?.jsonPrimitive?.content ?: "",
            options = (q["options"]?.jsonArray ?: return null).take(6).map {
                val o = it.jsonObject
                AskOption(
                    label = o["label"]?.jsonPrimitive?.content ?: "",
                    description = o["description"]?.jsonPrimitive?.content ?: "",
                )
            },
            multiSelect = q["multiSelect"]?.jsonPrimitive?.content == "true",
        )
    }.getOrNull()
}

/**
 * 权限/提问卡。回调：
 * - onDecision(allow, message, remember) 普通权限
 * - AskUserQuestion 走 onDecision(false, 答案文本, null)（web 端同款协议）
 * 提交后由调用方将 submitted 置 true 防止重复点击。
 */
@Composable
fun PermCard(
    perm: PendingPerm,
    submitted: Boolean,
    onDecision: (allow: Boolean, message: String?, remember: String?) -> Unit,
) {
    val ask = remember(perm.requestId) { parseAskQuestion(perm) }
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(ownwardColors.Warn)
                Spacer(Modifier.width(8.dp))
                Text(
                    if (ask != null) "agent 提问" else "权限请求：${perm.toolName}",
                    style = MaterialTheme.typography.labelLarge,
                    color = ownwardColors.Warn,
                )
            }
            Spacer(Modifier.height(6.dp))
            Text(
                ask?.question?.ifBlank { perm.brief } ?: perm.brief,
                style = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.height(10.dp))
            if (submitted) {
                Text("已提交", style = MaterialTheme.typography.bodySmall, color = ownwardColors.Success)
            } else if (ask != null) {
                AskOptions(ask) { answer -> onDecision(false, answer, null) }
            } else {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Button(
                        onClick = { onDecision(true, null, null) },
                        colors = ButtonDefaults.buttonColors(containerColor = ownwardColors.Success),
                    ) { Text("批准") }
                    OutlinedButton(onClick = { onDecision(true, null, "session") }) { Text("总是（本会话）") }
                    OutlinedButton(
                        onClick = { onDecision(false, null, null) },
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = ownwardColors.Danger),
                    ) { Text("拒绝") }
                }
            }
        }
    }
}

@Composable
private fun AskOptions(ask: AskQuestion, onAnswer: (String) -> Unit) {
    var selected by rememberSaveable(ask.question) { mutableStateOf(setOf<String>()) }
    var freeText by rememberSaveable(ask.question) { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ask.options.forEach { opt ->
            val isSel = opt.label in selected
            Surface(
                shape = MaterialTheme.shapes.medium,
                color = if (isSel) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)
                else MaterialTheme.colorScheme.surface,
                modifier = Modifier.fillMaxWidth().clickable {
                    if (ask.multiSelect) {
                        selected = if (isSel) selected - opt.label else selected + opt.label
                    } else onAnswer(opt.label)
                },
            ) {
                Column(Modifier.padding(10.dp)) {
                    Text(opt.label, style = MaterialTheme.typography.bodyMedium,
                        color = if (isSel) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                    if (opt.description.isNotBlank()) {
                        Text(opt.description, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
        if (ask.multiSelect && selected.isNotEmpty()) {
            Button(onClick = { onAnswer(selected.joinToString("、")) }) { Text("确认所选") }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = freeText,
                onValueChange = { freeText = it },
                placeholder = { Text("自定义回答…") },
                modifier = Modifier.weight(1f),
                textStyle = MaterialTheme.typography.bodySmall,
            )
            TextButton(onClick = { if (freeText.isNotBlank()) onAnswer(freeText) }) { Text("回答") }
        }
    }
}

// ---- 任务会话消息 ----

@Composable
fun DevMessageRow(msg: DevMsg, client: OwnwardClient) {
    // 图片行（agent 截图/读图）：不折叠进工具行，直接内联展示
    if (msg.role == "tool" && msg.name == "image") {
        MsgImages(msg.images, client)
        return
    }
    // 每条消息都长按可复制（含 agent 还在输出的那条——见 copyOnLongPress）
    val copy = copyOnLongPress { msg.text }
    when (msg.role) {
        // ChatGPT 式语法：用户消息是右侧中性灰「请求标签」，助手回复是无气泡直排文档
        "user" -> Column(
            Modifier.fillMaxWidth().padding(start = 56.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
            horizontalAlignment = Alignment.End,
        ) {
            Surface(shape = RoundedCornerShape(20.dp), color = ownwardColors.UserBubble, modifier = copy) {
                Text(
                    msg.text,
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                )
            }
        }

        "assistant" -> Box(Modifier.fillMaxWidth().then(copy).padding(horizontal = 16.dp, vertical = 8.dp)) {
            MarkdownText(msg.text)
        }

        "tool" -> ToolRow(name = msg.name ?: "tool", text = msg.text)

        else -> Text( // system / thinking
            msg.text,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.fillMaxWidth().then(copy).padding(horizontal = 16.dp, vertical = 3.dp),
        )
    }
    MsgImages(msg.images, client) // 用户消息带附件时，缩略图跟在气泡下
}

@Composable
private fun MsgImages(images: List<String>?, client: OwnwardClient) {
    if (images.isNullOrEmpty()) return
    val context = LocalContext.current
    val auth = client.authHeader()
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        images.forEach { path ->
            coil.compose.AsyncImage(
                model = coil.request.ImageRequest.Builder(context)
                    .data(client.absUrl(path))
                    .apply { auth?.let { (h, v) -> setHeader(h, v) } }
                    .build(),
                contentDescription = null,
                modifier = Modifier
                    .heightIn(max = 240.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant),
            )
        }
    }
}

// ---- 连续工具调用折叠 ----

// 分组规则（FeedItem / foldToolRuns / toolRunSubtitle）在 Feed.kt——那边不碰 Compose，能直接跑 JVM 测试

/** 会话流一项的渲染入口。live = 这是流的末尾且本轮还在跑（调用方按倒序下标 i==0 判断）。 */
@Composable
fun FeedRow(item: FeedItem, live: Boolean, client: OwnwardClient) {
    when (item) {
        is FeedItem.One -> DevMessageRow(item.msg, client)
        is FeedItem.Tools -> ToolRunGroup(item.msgs, live)
    }
}

/**
 * 折叠起来的一段工具调用。
 * 收起时只说「跑到第几步、有没有出错」，展开才是原来那一条条的明细。
 * 出错条数单独标红摆在标题上：折叠可以省掉过程，但不能把失败一起藏了。
 */
@Composable
fun ToolRunGroup(msgs: List<DevMsg>, live: Boolean) {
    var open by rememberSaveable { mutableStateOf(false) }
    val errors = msgs.count { it.isToolError() }
    val subtitle = toolRunSubtitle(msgs, live)
    // 点开/收起；长按复制整段明细（收起状态下也能复制，不用先展开）
    val copy = copyOnLongPress(onClick = { open = !open }, indicate = true) {
        msgs.joinToString("\n") { "${it.toolLabel()} ${it.text}".trim() }
    }
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = ownwardColors.Surface2,
        border = BorderStroke(1.dp, ownwardColors.OutlineFaint),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
    ) {
        Column(Modifier.then(copy).padding(horizontal = 12.dp, vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    if (live) "⚙ 正在执行 · 第 ${msgs.size} 步" else "⚙ 执行了 ${msgs.size} 步",
                    style = MaterialTheme.typography.bodySmall,
                    color = ownwardColors.TextDim,
                )
                if (errors > 0) {
                    Spacer(Modifier.width(6.dp))
                    Text(
                        "· $errors 处出错",
                        style = MaterialTheme.typography.bodySmall,
                        color = ownwardColors.Danger,
                    )
                }
                Spacer(Modifier.weight(1f))
                Icon(
                    if (open) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                    contentDescription = if (open) "收起明细" else "展开明细",
                    tint = ownwardColors.TextDim,
                    modifier = Modifier.size(18.dp),
                )
            }
            if (!open && subtitle.isNotBlank()) {
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = ownwardColors.TextDim.copy(alpha = 0.65f),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(top = 2.dp),
                )
            }
        }
    }
    // 明细走原来的 ToolRow：每条仍可单独展开看完整输出，展开态的样子和没折叠时一模一样
    if (open) msgs.forEach { ToolRow(name = it.toolLabel(), text = it.text) }
}

@Composable
fun ToolRow(name: String, text: String) {
    var open by rememberSaveable { mutableStateOf(false) }
    val firstLine = text.lineSequence().firstOrNull()?.take(80) ?: ""
    // 点开/收起照旧；长按复制整段工具输出（折叠状态下也能复制，不用先展开）
    val copy = copyOnLongPress(onClick = { open = !open }, indicate = true) { text }
    Column(
        Modifier
            .fillMaxWidth()
            .then(copy)
            .padding(horizontal = 16.dp, vertical = 2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "⚙ $name",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontFamily = FontFamily.Monospace,
            )
            Spacer(Modifier.width(6.dp))
            Text(
                firstLine,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                maxLines = 1,
            )
        }
        if (open) {
            Text(
                text,
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
                lineHeight = 15.sp,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 4.dp)
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(6.dp))
                    .horizontalScroll(rememberScrollState())
                    .padding(8.dp),
            )
        }
    }
}

// ---- 一体化 composer（ChatGPT 式 pill：附件/输入/主动作一个容器，主动作原位 morph）----

/**
 * 排队中的消息：贴在输入框正上方。
 * 放会话顶部（原来的位置）等于没放——那儿在滚动内容的最上头，人正盯着底部等回复，
 * 根本看不见自己刚发的那条还卡在队里。队列讲的就是「我刚发的还没轮到」，得挨着输入框。
 */
@Composable
private fun QueuedStrip(queued: List<QueuedView>, onCancel: ((QueuedView) -> Unit)?) {
    if (queued.isEmpty()) return
    Column(Modifier.fillMaxWidth().padding(start = 8.dp, end = 8.dp, bottom = 6.dp)) {
        Text(
            "排队中 ${queued.size} 条 · 本轮结束自动发出",
            style = MaterialTheme.typography.labelSmall,
            color = ownwardColors.TextDim,
            modifier = Modifier.padding(start = 4.dp, bottom = 3.dp),
        )
        queued.forEach { q ->
            Surface(
                shape = RoundedCornerShape(14.dp),
                color = ownwardColors.Surface2,
                border = BorderStroke(1.dp, ownwardColors.OutlineFaint),
                modifier = Modifier.fillMaxWidth().padding(vertical = 1.dp),
            ) {
                Row(
                    Modifier.padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        q.text.ifBlank { if (q.images > 0) "${q.images} 张图片" else "（空）" },
                        style = MaterialTheme.typography.bodySmall,
                        color = ownwardColors.Text,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).padding(vertical = 4.dp),
                    )
                    if (q.text.isNotBlank() && q.images > 0) Text(
                        " +${q.images} 图",
                        style = MaterialTheme.typography.labelSmall,
                        color = ownwardColors.TextDim,
                    )
                    // 撤回按 q.id 走。老 daemon 不带 id，撤不了——那就不画钮，不摆假按钮
                    if (onCancel != null && q.id.isNotBlank()) IconButton(
                        onClick = { onCancel(q) },
                        modifier = Modifier.size(32.dp),
                    ) { Icon(Icons.Filled.Close, "撤回这条", tint = ownwardColors.TextDim, modifier = Modifier.size(16.dp)) }
                }
            }
        }
    }
}

/**
 * 斜杠命令补全：浮在输入框正上方（键盘挡不到），点一条就把整条输入换成 "/name "，
 * 光标落在末尾直接写参数。超过一屏就滚，最多 40 条（Slash.matches 截断）。
 */
@Composable
private fun SlashMenu(items: List<SlashCmd>, onPick: (SlashCmd) -> Unit) {
    if (items.isEmpty()) return
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = ownwardColors.Surface2,
        border = BorderStroke(1.dp, ownwardColors.OutlineFaint),
        modifier = Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, bottom = 6.dp),
    ) {
        Column(Modifier.heightIn(max = 200.dp).verticalScroll(rememberScrollState())) {
            items.forEach { cmd ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { onPick(cmd) }
                        .padding(horizontal = 14.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "/${cmd.name}",
                        style = MaterialTheme.typography.bodyMedium,
                        fontFamily = FontFamily.Monospace,
                        color = ownwardColors.Text,
                    )
                    if (cmd.desc.isNotBlank()) {
                        Spacer(Modifier.width(10.dp))
                        Text(
                            cmd.desc,
                            style = MaterialTheme.typography.bodySmall,
                            color = ownwardColors.TextDim,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

/**
 * busy：不可中断的忙碌（chat 流式/发送落盘中）→ 主动作转圈
 * running + onInterrupt：任务运行中且无草稿 → 主动作为 Stop；一旦输入内容切回 Send（排队发送）
 * 容器自带毛玻璃（glassBar），调用方直接放 Scaffold bottomBar
 */
@Composable
fun OwnwardComposer(
    input: String,
    onInput: (String) -> Unit,
    pendingImages: List<Pair<Uri, OutImage>>,
    onRemoveImage: (Uri) -> Unit,
    onPickImages: () -> Unit,
    canSend: Boolean,
    busy: Boolean,
    running: Boolean = false,
    queued: List<QueuedView> = emptyList(), // agent 忙时已发出、等本轮结束的消息
    onCancelQueued: ((QueuedView) -> Unit)? = null, // 撤回其中一条（服务端按 id 撤，撤不到会报错）
    controlHint: String? = null,
    controlAction: Pair<String, () -> Unit>? = null, // 提示旁的动作（如「接管输入」）：label to onClick
    commands: List<String>? = null, // 斜杠命令补全表；null = 这个输入框不开补全（非 claude 引擎 / AI 对话）
    placeholder: String = "发消息…",
    onSend: () -> Unit,
    onInterrupt: (() -> Unit)? = null,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .glassBar()
            .navigationBarsPadding()
            .imePadding()
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        if (controlHint != null) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth().padding(start = 12.dp, bottom = 2.dp),
            ) {
                Text(
                    controlHint,
                    style = MaterialTheme.typography.labelMedium,
                    color = ownwardColors.Warn,
                    modifier = Modifier.weight(1f),
                )
                controlAction?.let { (label, onClick) ->
                    TextButton(onClick = onClick) { Text(label) }
                }
            }
        }
        QueuedStrip(queued, onCancelQueued)
        // 斜杠命令补全：只在「整条输入就是一个 / 开头的词」时弹（规则见 Slash.kt）
        val slashItems = if (canSend) Slash.matches(input, commands) else emptyList()
        SlashMenu(slashItems) { onInput(Slash.accept(it)) }
        if (pendingImages.isNotEmpty()) {
            Row(
                Modifier.horizontalScroll(rememberScrollState()).padding(start = 4.dp, bottom = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                pendingImages.forEach { (uri, _) ->
                    Box {
                        coil.compose.AsyncImage(
                            model = uri,
                            contentDescription = null,
                            modifier = Modifier
                                .size(64.dp)
                                .clip(RoundedCornerShape(12.dp))
                                .background(ownwardColors.Surface2),
                        )
                        IconButton(
                            onClick = { onRemoveImage(uri) },
                            modifier = Modifier.size(20.dp).align(Alignment.TopEnd),
                        ) { Icon(Icons.Filled.Close, "移除", modifier = Modifier.size(12.dp)) }
                    }
                }
            }
        }
        Surface(
            shape = RoundedCornerShape(26.dp),
            color = ownwardColors.Surface2,
            border = BorderStroke(1.dp, ownwardColors.OutlineFaint),
        ) {
            Row(Modifier.heightIn(min = 52.dp).padding(6.dp), verticalAlignment = Alignment.Bottom) {
                IconButton(
                    onClick = onPickImages,
                    enabled = canSend,
                    modifier = Modifier.size(40.dp),
                ) { Icon(Icons.Filled.Add, "附件", tint = ownwardColors.TextDim) }
                Box(
                    Modifier.weight(1f).padding(horizontal = 6.dp, vertical = 9.dp),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    BasicTextField(
                        value = input,
                        onValueChange = onInput,
                        enabled = canSend,
                        maxLines = 6,
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = ownwardColors.Text),
                        cursorBrush = SolidColor(ownwardColors.Accent),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (input.isEmpty()) Text(
                        if (canSend) placeholder else "无法输入",
                        style = MaterialTheme.typography.bodyLarge,
                        color = ownwardColors.TextDim,
                    )
                }
                val sendEnabled = canSend && (input.isNotBlank() || pendingImages.isNotEmpty())
                val mode = when {
                    busy -> "busy"
                    running && onInterrupt != null && !sendEnabled -> "stop"
                    else -> "send"
                }
                AnimatedContent(
                    targetState = mode,
                    transitionSpec = {
                        (fadeIn(tween(180)) + scaleIn(initialScale = 0.7f, animationSpec = tween(180)))
                            .togetherWith(fadeOut(tween(120)) + scaleOut(targetScale = 0.7f, animationSpec = tween(120)))
                    },
                    label = "composerAction",
                ) { m ->
                    when (m) {
                        "busy" -> Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        }

                        "stop" -> Box(
                            Modifier
                                .size(40.dp)
                                .clip(CircleShape)
                                .background(ownwardColors.Danger)
                                .clickable { onInterrupt?.invoke() },
                            contentAlignment = Alignment.Center,
                        ) { Icon(Icons.Filled.Stop, "中断", tint = ownwardColors.Bg, modifier = Modifier.size(20.dp)) }

                        else -> Box(
                            Modifier
                                .size(40.dp)
                                .clip(CircleShape)
                                .background(if (sendEnabled) ownwardColors.Text else ownwardColors.Surface3)
                                .clickable(enabled = sendEnabled, onClick = onSend),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                Icons.Filled.ArrowUpward, "发送",
                                tint = if (sendEnabled) ownwardColors.Bg else ownwardColors.TextDim,
                                modifier = Modifier.size(20.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

/** 流式等待三点：alpha 错峰呼吸，取代打字机光标 */
@Composable
fun ThinkingDots(modifier: Modifier = Modifier) {
    val t = rememberInfiniteTransition(label = "thinking")
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        repeat(3) { i ->
            val alpha by t.animateFloat(
                initialValue = 0.25f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(
                    animation = tween(600),
                    repeatMode = RepeatMode.Reverse,
                    initialStartOffset = StartOffset(i * 200),
                ),
                label = "dot$i",
            )
            Box(Modifier.size(6.dp).background(ownwardColors.TextDim.copy(alpha = alpha), CircleShape))
        }
    }
}

@Composable
fun PlanStrip(plan: List<PlanStep>) {
    if (plan.isEmpty()) return
    var open by rememberSaveable { mutableStateOf(false) }
    val done = plan.count { it.status == "completed" }
    val current = plan.firstOrNull { it.status == "in_progress" }?.text
        ?: plan.firstOrNull { it.status == "pending" }?.text ?: "全部完成"
    Surface(
        color = Color.Transparent, // 在任务详情顶栏玻璃层内，不再自带底色
        modifier = Modifier.fillMaxWidth().clickable { open = !open },
    ) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
            Text(
                "▶ $current · $done/${plan.size}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
                maxLines = 1,
            )
            if (open) plan.forEach { step ->
                Text(
                    when (step.status) {
                        "completed" -> "☑ ${step.text}"
                        "in_progress" -> "▶ ${step.text}"
                        else -> "☐ ${step.text}"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = if (step.status == "completed") MaterialTheme.colorScheme.onSurfaceVariant
                    else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.padding(top = 3.dp),
                )
            }
        }
    }
}
