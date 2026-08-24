package ai.ownward.app.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

// 与 daemon 的契约一一对应（src/actions.ts、src/agent-session.ts、src/chat.ts 等）。
// 服务端字段会演进，所以统一 ignoreUnknownKeys。
val AppJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = false
}

@Serializable
data class StateSnapshot(
    val now: String = "", // ISO 时间串
    val pid: Long = 0,
    val queue: Int = 0,
    val vaultToday: String? = null,
    val allowFullAccess: Boolean = false, // architecture.allowFullAccess：bypass 权限的服务端门
    val dispatchDefaults: DispatchDefaults = DispatchDefaults(), // config dispatch.defaults（派任务预填，前端不硬编码）
)

/** config dispatch.defaults = {dir, model, permission, codex, provider}，字段全可缺 */
@Serializable
data class DispatchDefaults(
    val dir: String? = null,
    val model: String? = null,
    val permission: String? = null, // safe | bypass
    val codex: Boolean? = null,     // 旧开关；provider 优先
    val provider: String? = null,   // claude | codex | codebuddy
)

/** POST /api/work 成功体：{ok, msg, task}。task 是完整 WorkTask，形状随服务端演进——只解 id，别整包强类型 */
@Serializable
data class DispatchResult(
    val ok: Boolean = false,
    val msg: String = "",
    val task: JsonElement? = null,
) {
    fun taskId(): String? = runCatching {
        (task as? kotlinx.serialization.json.JsonObject)?.get("id")
            ?.let { it as? kotlinx.serialization.json.JsonPrimitive }?.content
    }.getOrNull()?.takeIf { it.isNotBlank() }
}

@Serializable
data class ActionRef(
    val chat_id: String? = null,
    val task_id: String? = null,
    val url: String? = null,
    val mail_id: String? = null,
    val note: String? = null,
)

@Serializable
data class Action(
    val id: String,
    val kind: String, // reply | review | approve | follow_up | decide
    val source: String = "",
    val title: String = "",
    val reason: String = "",
    val state: String = "open", // open | snoozed | processing | resolved | dismissed
    val createdAt: String = "",
    val updatedAt: String = "",
    val snoozedUntil: String? = null,
    val ref: ActionRef = ActionRef(),
)

@Serializable
data class AttentionItem(
    val taskId: String,
    val project: String = "",
    val backend: String = "",
    val kind: String = "stuck", // stuck | done
    val title: String = "",
    val detail: String = "",
    val age: Long = 0,
    val since: Long = 0,
)

@Serializable
data class RoutineCard(
    val id: String,
    val name: String = "",
    val time: String = "",
    val date: String = "",
    val isToday: Boolean = false,
    val overdue: Boolean = false,
    val nextLabel: String = "",
    val daysUntil: Int = 0,
    val status: String = "upcoming", // pending | draft | writing | written | skipped | upcoming
    val hasDraft: Boolean = false,
    val taskId: String? = null,
    val stale: Boolean = false,
)

@Serializable
data class Meeting(
    val id: String = "",
    val title: String = "",
    val start: String = "",
    val end: String = "",
    val organizer: String? = null,
    val meetingUrl: String? = null,
)

@Serializable
data class WorkTask(
    val id: String,
    val project: String = "",
    val projectDir: String? = null,
    val cwd: String = "",
    val task: String = "",
    val title: String? = null,
    val mode: String = "", // terminal | claude-bg | codex-bg
    val engine: Boolean? = null, // true = ownward 引擎驱动的会话（src/workbench.ts 写布尔）
    val model: String? = null,
    val status: String = "running", // running | exited | done
    val startedAt: String = "",
    val endedAt: String? = null,
    val exitCode: Int? = null,
    val ccSessionId: String? = null, // terminal 任务认领到的底层 Claude 会话（旁观/接管到引擎用）
)

@Serializable
data class RecentSession(
    val id: String,
    val project: String = "",
    val title: String = "",
    val mode: String = "",
    val status: String = "",
    val startedAt: String = "",
    val lastAt: Long = 0, // epoch ms
    val msgs: Int = 0,
    val userMsgs: Int = 0,
    val last: String = "",
)

@Serializable
data class DevMsg(
    val role: String, // user | assistant | tool | system | thinking
    val text: String = "",
    val name: String? = null, // name="image" 的 tool 消息 = 图片行，内联渲染
    val ts: String = "",
    val images: List<String>? = null, // 服务端落盘出的图片路径（/api/agent-image/...）
)

@Serializable
data class PendingPerm(
    val requestId: String,
    val toolName: String = "",
    val input: JsonElement? = null,
    val at: Long = 0,
    val brief: String = "",
)

@Serializable
data class PlanStep(
    val text: String = "",
    val status: String = "pending", // pending | in_progress | completed
)

@Serializable
data class TokenUsage(
    val input: Long? = null,
    val output: Long? = null,
    val total: Long? = null,
)

@Serializable
data class QueuedView(
    // 撤回按 id 认人（服务端只收 queueId，不收下标）。老 daemon 不带 id → 空串，
    // 这种时候不画撤回钮：撤不了就别摆按钮
    val id: String = "",
    val text: String = "",
    val btw: Boolean = false,
    val images: Int = 0,
)

@Serializable
data class AgentState(
    val messages: List<DevMsg> = emptyList(),
    val turn: String = "idle", // running | idle
    val alive: Boolean = false,
    val partial: String = "",
    val pending: List<PendingPerm> = emptyList(),
    val backend: String = "claude",
    val control: String = "ownward", // ownward | external | observing
    val queued: List<QueuedView> = emptyList(),
    val plan: List<PlanStep> = emptyList(),
    val tokens: TokenUsage? = null,
    val model: String? = null,
    // provider init 帧回报的 slash_commands（输入框 / 补全用）；codex 之类不回报时为空表
    val commands: List<String> = emptyList(),
    val ctxTokens: Long? = null,
    val lastActivityAt: Long = 0,
    // Runner 不可达时服务端仍回 200 但标 stale——不显示会让人对着过期快照以为 agent 还在干活
    val stale: Boolean = false,
    val errorCode: String? = null,
    val operability: String = "active", // active | read-only（归档/隔离会话禁止输入）
    val resume: ResumeInfo? = null, // 释放输入权后在别的终端续聊的命令（kernel/sessions/contracts.ts）
)

@Serializable
data class ResumeInfo(
    val id: String = "",
    val tool: String = "",
    val cmd: String = "",
)

/** POST /api/dev/control 回执：control 是切换后的租约状态 */
@Serializable
data class ControlResult(
    val ok: Boolean = false,
    val control: String = "",
    val msg: String = "",
)

/**
 * GET /api/cc/sessions：本机全部外部 agent 会话（Claude ~/.claude/projects + Codex ~/.codex/sessions 合并）。
 * id 是稳定引用键（claude "<hashDir>/<uuid>"、codex "cdx:<home>:<id>"），含 "/" 和 ":"——进路由参数必须 Uri.encode。
 * kind 只有 codex 会带；缺省即 claude。
 */
@Serializable
data class ObservedSession(
    val id: String,
    val cwd: String = "",
    val project: String = "",
    val title: String = "",
    val firstUser: String = "",
    val mtime: Long = 0, // epoch ms
    val active: Boolean = false, // 2 分钟内有写入 = 正被别的端驱动，此时不能接管
    val kind: String? = null,
) {
    val isCodex: Boolean get() = kind == "codex"
}

/** GET /api/cc/session?id&after：增量页。offset 回传给下一次 after；文件缩小（offset < 上次）= 截断重建，需清空累积 */
@Serializable
data class CcPage(
    val ok: Boolean = true,
    val msg: String = "",
    val messages: List<DevMsg> = emptyList(),
    val offset: Long = 0,
    val truncated: Boolean = false,
)

/** POST /api/cc/adopt-capability：接管凭证（一次性、短时；会话正在被驱动时 409 DEV_SESSION_DISCOVERY_ACTIVE） */
@Serializable
data class AdoptCapability(
    val ok: Boolean = false,
    val adoptToken: String? = null,
    val msg: String = "",
    val errorCode: String? = null,
)

/** GET /api/tasks/{id}/cc-session：terminal 任务底层 Claude 会话 id（还没认领到时 ok=false） */
@Serializable
data class TaskCcSession(
    val ok: Boolean = false,
    val sessionId: String? = null,
    val active: Boolean = false,
    val msg: String = "",
)

@Serializable
data class ChatImageMeta(
    val id: String,
    val mediaType: String = "image/jpeg",
    val bytes: Long = 0,
)

@Serializable
data class AiMessage(
    val role: String, // user | assistant
    val text: String = "",
    val ts: String = "",
    val images: List<ChatImageMeta> = emptyList(),
)

@Serializable
data class AiChat(
    val id: String,
    val title: String = "",
    val provider: String = "claude",
    val model: String = "",
    val createdAt: String = "",
    val updatedAt: String = "",
    val messages: List<AiMessage> = emptyList(),
)

// /api/chat/providers 返回任意供应商键（claude/codex/codex-alt/…）——用 Map 解码，别硬编码两键

@Serializable
data class FeedEntry(
    val ts: String = "",
    val kind: String = "log", // notify | log
    val source: String = "",
    val text: String = "",
    val detail: String? = null,
    val link: String? = null,
)

/** POST /api/chat/send 的 NDJSON 流事件 */
sealed class ChatEvent {
    data class Delta(val text: String) : ChatEvent()
    data class Tool(val text: String) : ChatEvent()
    data class Error(val msg: String) : ChatEvent()
    data class Done(val chat: AiChat) : ChatEvent()
}

/** 发送图片：裸 base64，无 data: 前缀 */
@Serializable
data class OutImage(
    val media_type: String,
    val data: String,
)

@Serializable
data class OkMsg(
    val ok: Boolean = false,
    val msg: String = "",
)

@Serializable
data class ProjectDir(
    val name: String = "",
    val dir: String = "",
)

/** GET /api/fs/dirs：目录浏览严格限制在服务端 architecture.allowedRoots 内。 */
@Serializable
data class FsDirEntry(
    val name: String = "",
    val path: String = "",
    val git: Boolean = false,
)

@Serializable
data class FsDirListing(
    val ok: Boolean = false,
    val path: String? = null,
    val parent: String? = null,
    val entries: List<FsDirEntry> = emptyList(),
    val truncated: Boolean = false,
    val msg: String = "",
)

/** GET /api/app/android：daemon 端 data/app/android.json（由 scripts/android-release.sh 写入） */
@Serializable
data class AppRelease(
    val ok: Boolean = false,
    val versionName: String = "",
    val versionCode: Int = 0,
    val notes: String = "",
)
