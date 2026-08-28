package ai.ownward.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiException(val code: Int, message: String, val errorCode: String? = null) : IOException(message)

internal fun fsDirsPath(path: String?): String =
    "/api/fs/dirs" + (path?.takeIf { it.isNotBlank() }?.let {
        "?path=" + java.net.URLEncoder.encode(it, "UTF-8")
    } ?: "")

/**
 * ownward daemon 客户端。认证约定（src/server.ts）：
 * - Authorization: Bearer <token>，绝不发 Origin（发了就要过 CSRF 校验）
 * - 429 = 密码错误次数过多被封 10 分钟，不能拿旧 token 重试
 * - 错误体统一 {ok:false, msg}，msg 是中文、可直接展示
 */
class OwnwardClient(private val baseUrl: String, private val token: String) {

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build()

    // 聊天 NDJSON 流和 SSE：读超时要拉长（LLM 首 token 可能等很久）
    private val streamHttp = http.newBuilder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private fun req(path: String): Request.Builder =
        Request.Builder()
            .url(baseUrl.trimEnd('/') + path)
            .apply { if (token.isNotBlank()) header("Authorization", "Bearer $token") }  // 空 token 不发头：本地直连免鉴权，远程发空 Bearer 只会吃 401+失败限速计数
            .header("Accept", "application/json")

    private fun jsonBody(obj: JsonObject) =
        obj.toString().toRequestBody("application/json".toMediaType())

    private fun failMsg(code: Int, body: String): String {
        val msg = runCatching { AppJson.decodeFromString<OkMsg>(body).msg }.getOrNull()
        return if (!msg.isNullOrBlank()) msg else when (code) {
            401 -> "token 无效，请检查设置"
            429 -> "尝试次数过多，10 分钟后再试"
            else -> "请求失败 HTTP $code"
        }
    }

    private suspend fun exec(rb: Request.Builder): String = withContext(Dispatchers.IO) {
        http.newCall(rb.build()).execute().use { resp ->
            val body = resp.body?.string() ?: ""
            if (!resp.isSuccessful) {
                val errorCode = runCatching {
                    AppJson.parseToJsonElement(body).jsonObject["errorCode"]?.jsonPrimitive?.content
                }.getOrNull()
                throw ApiException(resp.code, failMsg(resp.code, body), errorCode)
            }
            body
        }
    }

    private suspend inline fun <reified T> get(path: String): T =
        AppJson.decodeFromString(exec(req(path)))

    private suspend inline fun <reified T> post(path: String, obj: JsonObject): T =
        AppJson.decodeFromString(exec(req(path).post(jsonBody(obj))))

    // ---- 连接检查 ----
    suspend fun state(): StateSnapshot = get("/api/state")

    // ---- 今日 ----
    suspend fun actions(): List<Action> = get("/api/actions")
    suspend fun actionState(id: String, state: String, snoozeMin: Int? = null): OkMsg =
        post("/api/actions/state", buildJsonObject {
            put("id", id); put("state", state)
            if (snoozeMin != null) put("snoozeMin", snoozeMin)
        })

    suspend fun attention(): List<AttentionItem> = get("/api/attention")
    suspend fun routines(): List<RoutineCard> = get("/api/routines")
    suspend fun calendarToday(): List<Meeting> = get("/api/calendar/today")

    suspend fun routineGenerate(id: String): OkMsg =
        post<OkMsg>("/api/routines/generate", buildJsonObject { put("id", id) }).requireOk()

    suspend fun routineDraft(id: String, date: String): RoutineDraft =
        get<RoutineDraft>("/api/routines/draft?id=" + id.urlEnc() + "&date=" + date.urlEnc()).also {
            if (!it.ok) throw ApiException(200, it.msg.ifBlank { "读取草稿失败" })
        }

    suspend fun routineSaveDraft(id: String, date: String, content: String): OkMsg =
        post<OkMsg>("/api/routines/draft", buildJsonObject {
            put("id", id); put("date", date); put("content", content)
        }).requireOk()

    suspend fun routineWrite(id: String, date: String): OkMsg =
        post<OkMsg>("/api/routines/write", buildJsonObject { put("id", id); put("date", date) }).requireOk()

    suspend fun routineSkip(id: String, date: String): OkMsg =
        post<OkMsg>("/api/routines/skip", buildJsonObject { put("id", id); put("date", date) }).requireOk()

    // ---- 任务 / agent 会话 ----
    suspend fun tasks(): List<WorkTask> = get("/api/tasks")
    suspend fun recentSessions(): List<RecentSession> = get("/api/dev/recent")
    suspend fun devMessages(id: String): AgentState =
        get("/api/dev/messages?id=" + id.urlEnc())

    suspend fun devSend(id: String, text: String, images: List<OutImage> = emptyList()): OkMsg =
        post("/api/dev/send", buildJsonObject {
            put("id", id); put("text", text)
            if (images.isNotEmpty()) put("images", buildJsonArray {
                images.forEach { img ->
                    add(buildJsonObject { put("media_type", img.media_type); put("data", img.data) })
                }
            })
        })

    suspend fun devInterrupt(id: String): OkMsg =
        post("/api/dev/interrupt", buildJsonObject { put("id", id) })

    suspend fun devHandoff(id: String, providerId: String, confirmUnknownOutcome: Boolean = false): OkMsg =
        post("/api/dev/handoff", buildJsonObject {
            put("id", id); put("providerId", providerId); put("reason", "manual")
            put("confirmUnknownOutcome", confirmUnknownOutcome)
        })

    /**
     * 接管租约：take = 取得输入权（ownward），release = 交还只旁观（observing）。
     * Run 执行中 take 会被拒（SESSION_CONTROL_BUSY），msg 可直接展示。
     */
    suspend fun devControl(id: String, action: String): ControlResult =
        post("/api/dev/control", buildJsonObject { put("id", id); put("action", action) })

    // ---- 外部会话：旁观 + 接管（对齐 web/tasks.js 的 CC 旁观区） ----
    suspend fun ccSessions(): List<ObservedSession> = get("/api/cc/sessions")

    /** 增量读：after 传上次 offset；首帧传 0。长会话首帧会截断前文（truncated） */
    suspend fun ccSession(id: String, after: Long): CcPage =
        get("/api/cc/session?id=" + id.urlEnc() + "&after=" + after)

    /** terminal 任务 → 底层 Claude 会话 id（还没落盘时 ok=false，稍后重试） */
    suspend fun taskCcSession(taskId: String): TaskCcSession =
        get("/api/tasks/" + taskId.urlEnc() + "/cc-session")

    /**
     * 接管外部会话两步走：先签一次性凭证（会话空闲、cwd 还在才签得出），再拿凭证接管成 ownward 任务。
     * 成功体同 /api/work：{ok, msg, task}，task.id 即新会话，可直接进详情续聊。
     */
    suspend fun ccAdoptCapability(id: String): AdoptCapability =
        post("/api/cc/adopt-capability", buildJsonObject { put("id", id) })

    suspend fun ccAdopt(id: String, adoptToken: String): DispatchResult =
        post("/api/cc/adopt", buildJsonObject { put("id", id); put("adoptToken", adoptToken) })

    /** terminal 任务一键接管到引擎（Terminal 里的会话必须已空闲，否则 409） */
    suspend fun adoptTerminal(taskId: String): DispatchResult =
        post("/api/task/adopt-terminal", buildJsonObject { put("id", taskId) })

    /**
     * 撤回一条还没发出的排队消息。只能按 queueId 撤、不能按下标——手里的队列是轮询快照，
     * 下标随时会因为本轮结束、队列合并发出而错位。
     * 撤不到服务端回 409（"这条已经发出…"）并抛 ApiException 带中文原因——不许当成撤成功。
     */
    suspend fun devQueueRemove(id: String, queueId: String): OkMsg =
        post("/api/dev/queue", buildJsonObject { put("id", id); put("action", "remove"); put("queueId", queueId) })

    suspend fun devDecision(
        id: String, requestId: String, allow: Boolean,
        message: String? = null, remember: String? = null,
    ): OkMsg = post("/api/dev/decision", buildJsonObject {
        put("id", id); put("requestId", requestId); put("allow", allow)
        if (message != null) put("message", message)
        if (remember != null) put("remember", remember)
    })

    // ---- 对话 ----
    suspend fun chatList(): List<AiChat> = get("/api/chat/list")
    suspend fun chatMessages(id: String): AiChat =
        get("/api/chat/messages?id=" + id.urlEnc())
    suspend fun chatProviders(): Map<String, List<String>> = get("/api/chat/providers")
    suspend fun chatRename(id: String, title: String): OkMsg =
        post("/api/chat/rename", buildJsonObject { put("id", id); put("title", title) })
    suspend fun chatDelete(id: String): OkMsg =
        post("/api/chat/delete", buildJsonObject { put("id", id) })

    fun chatImageUrl(chatId: String, imageId: String): String =
        baseUrl.trimEnd('/') + "/api/chat/image?chat_id=${chatId.urlEnc()}&id=${imageId.urlEnc()}"

    fun authHeader(): Pair<String, String>? = if (token.isBlank()) null else "Authorization" to "Bearer $token"

    /** 服务端消息里带的绝对路径（如 /api/agent-image/...）拼成完整 URL */
    fun absUrl(path: String): String = baseUrl.trimEnd('/') + path

    /**
     * 发消息，NDJSON 流。收不到 Done 说明服务端没落盘，调用方必须回滚乐观气泡
     * （契约见 src/chat.ts：出错时服务端弹掉用户消息并删附件）。
     */
    fun chatSend(
        chatId: String?, text: String, provider: String, model: String,
        images: List<OutImage> = emptyList(),
    ): Flow<ChatEvent> = flow {
        val body = buildJsonObject {
            if (chatId != null) put("chat_id", chatId)
            put("text", text)
            put("provider", provider)
            put("model", model)
            if (images.isNotEmpty()) put("images", buildJsonArray {
                images.forEach { img ->
                    add(buildJsonObject { put("media_type", img.media_type); put("data", img.data) })
                }
            })
        }
        val call = streamHttp.newCall(req("/api/chat/send").post(jsonBody(body)).build())
        call.execute().use { resp: Response ->
            if (!resp.isSuccessful) {
                val b = resp.body?.string() ?: ""
                throw ApiException(resp.code, failMsg(resp.code, b))
            }
            val source = resp.body?.source() ?: throw IOException("对话服务返回了空响应")
            while (true) {
                val line = source.readUtf8Line() ?: break
                if (line.isBlank()) continue
                // 坏行跳过（对齐 web/chat.js）：daemon 是唯一写入方且写的是干净 JSON，坏行多为
                // 未来新增的帧格式；杀掉整条流会把用户消息回滚，前向兼容代价太大
                val obj = try {
                    AppJson.parseToJsonElement(line).jsonObject
                } catch (e: Exception) {
                    continue
                }
                when (obj.str("type")) {
                    "delta" -> emit(ChatEvent.Delta(obj.str("text")))
                    "tool" -> emit(ChatEvent.Tool(obj.str("text")))
                    "error" -> {
                        emit(ChatEvent.Error(obj.str("msg").ifBlank { "对话服务返回错误" }))
                        return@flow
                    }
                    "done" -> {
                        val chatJson = obj["chat"] ?: throw IOException("对话完成帧缺少会话数据")
                        val chat = try {
                            AppJson.decodeFromJsonElement(AiChat.serializer(), chatJson)
                        } catch (e: Exception) {
                            throw IOException("对话完成帧格式错误", e)
                        }
                        emit(ChatEvent.Done(chat))
                    }
                    else -> {}   // 未知帧跳过：服务端加新事件类型不该杀掉老客户端的整条流（前向兼容）
                }
            }
        }
    }.flowOn(Dispatchers.IO)

    // ---- 通知流 ----
    suspend fun feed(limit: Int = 100): List<FeedEntry> = get("/api/feed?limit=$limit")

    /** SSE /api/events：state 每 15s 一发即保活；断线由调用方重连 */
    fun events(): Flow<Pair<String, String>> = callbackFlow {
        val request = req("/api/events").header("Accept", "text/event-stream").build()
        val factory = EventSources.createFactory(streamHttp)
        val source = factory.newEventSource(request, object : EventSourceListener() {
            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                trySend((type ?: "message") to data)
            }

            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                close(t ?: IOException("SSE closed: ${response?.code}"))
            }

            override fun onClosed(eventSource: EventSource) {
                close()
            }
        })
        awaitClose { source.cancel() }
    }.flowOn(Dispatchers.IO)

    // ---- 派新任务 ----
    /**
     * POST /api/work（契约 src/verticals.ts scopedTasks.startWork：键白名单严格，多一个未知键整包 400）。
     * 固定 bg=true：手机端没有 terminal 通道。provider 只认 claude/codex/codebuddy；
     * 成功体 {ok, msg, task}，task 形状随服务端演进，只取 id（taskId()）。
     */
    suspend fun dispatchWork(
        dir: String, task: String, provider: String, worktree: Boolean,
        model: String?, permission: String?, images: List<OutImage> = emptyList(),
    ): DispatchResult = post("/api/work", buildJsonObject {
        put("dir", dir); put("task", task); put("bg", true)
        put("provider", provider); put("worktree", worktree)
        if (!model.isNullOrBlank()) put("model", model)
        if (!permission.isNullOrBlank()) put("permission", permission)
        if (images.isNotEmpty()) put("images", buildJsonArray {
            images.forEach { img ->
                add(buildJsonObject { put("media_type", img.media_type); put("data", img.data) })
            }
        })
    })

    suspend fun projects(): List<ProjectDir> = get("/api/projects")

    suspend fun fsDirs(path: String? = null): FsDirListing =
        get(fsDirsPath(path))

    // ---- 应用自更新 ----
    suspend fun appRelease(): AppRelease = get("/api/app/android")

    suspend fun downloadApk(dest: java.io.File) = withContext(Dispatchers.IO) {
        streamHttp.newCall(req("/app/ownward.apk").build()).execute().use { resp ->
            if (!resp.isSuccessful) throw ApiException(resp.code, "下载失败 HTTP ${resp.code}")
            dest.outputStream().use { out ->
                resp.body!!.byteStream().copyTo(out)
            }
        }
    }

    private fun JsonObject.str(key: String): String =
        (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: ""

    private fun String.urlEnc(): String = java.net.URLEncoder.encode(this, "UTF-8")

    private fun OkMsg.requireOk(): OkMsg {
        if (!ok) throw ApiException(200, msg.ifBlank { "操作失败" })
        return this
    }
}
