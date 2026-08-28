// ownward daemon 客户端（对齐 android data/OwnwardClient.kt）。认证约定（src/server.ts）：
// - Authorization: Bearer <token>，绝不发 Origin（发了就要过 CSRF 校验；URLSession 默认不发）
// - 空 token 不发头：本地直连免鉴权；远程发空 Bearer 只会吃 401 + 失败限速计数
// - 429 = 密码错误次数过多被封 10 分钟，不能拿旧 token 重试
// - 错误体统一 {ok:false, msg}，msg 是中文、可直接展示
import Foundation

struct ApiError: LocalizedError, Sendable, Equatable {
    let code: Int
    let message: String
    /// 服务端失败体可带 errorCode（如 SESSION_HANDOFF_UNKNOWN_CONFIRM_REQUIRED），策略性错误按它分流
    var errorCode: String? = nil
    var errorDescription: String? { message }
}

extension Error {
    /// 给 UI 看的一句话：服务端 msg 原样；网络层错误翻成人话
    var userMessage: String {
        if let api = self as? ApiError { return api.message }
        if let u = self as? URLError {
            switch u.code {
            case .notConnectedToInternet, .networkConnectionLost: return "网络不可用"
            case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed: return "无法连接服务器"
            case .timedOut: return "连接超时"
            case .cancelled: return "已取消"
            default: return u.localizedDescription
            }
        }
        if self is DecodingError { return "响应解析失败" }
        return localizedDescription
    }
}

final class OwnwardClient: Sendable {
    let base: String          // 无尾斜杠
    let token: String
    private let session: URLSession
    private let streamSession: URLSession

    init?(baseURL: String, token: String) {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", url.host() != nil else { return nil }
        base = trimmed
        self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 20
        cfg.timeoutIntervalForResource = 60
        cfg.httpCookieStorage = nil       // 鉴权只走 Bearer，不让服务端 302 下发的 cookie 干扰
        session = URLSession(configuration: cfg)
        // 聊天 NDJSON 流：首 token 可能等很久，单次读超时拉到 10 分钟，整条回复 1 小时
        let scfg = URLSessionConfiguration.default
        scfg.timeoutIntervalForRequest = 600
        scfg.timeoutIntervalForResource = 3600
        scfg.httpCookieStorage = nil
        streamSession = URLSession(configuration: scfg)
    }

    // MARK: - 底层

    func url(_ path: String) -> URL { URL(string: base + path)! }

    /// 服务端消息里带的绝对路径（如 /api/agent-image/...）拼成完整 URL
    func absURL(_ path: String) -> URL { url(path.hasPrefix("/") ? path : "/" + path) }

    var authHeader: (String, String)? { token.isEmpty ? nil : ("Authorization", "Bearer \(token)") }

    private func makeRequest(_ path: String, method: String = "GET", body: Data? = nil) -> URLRequest {
        var req = URLRequest(url: url(path))
        req.httpMethod = method
        if let (k, v) = authHeader { req.setValue(v, forHTTPHeaderField: k) }
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    private func failMessage(code: Int, body: Data) -> String {
        if let ok = try? JSONDecoder().decode(OkMsg.self, from: body), !ok.msg.isEmpty { return ok.msg }
        switch code {
        case 401: return "token 无效，请检查设置"
        case 429: return "尝试次数过多，10 分钟后再试"
        default: return "请求失败 HTTP \(code)"
        }
    }

    private func exec(_ req: URLRequest) async throws -> Data {
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw ApiError(code: -1, message: "无效响应") }
        guard (200..<300).contains(http.statusCode) else {
            let errorCode = (try? JSONDecoder().decode(ErrorCodeBody.self, from: data))?.errorCode
            throw ApiError(code: http.statusCode, message: failMessage(code: http.statusCode, body: data), errorCode: errorCode)
        }
        return data
    }

    private struct ErrorCodeBody: Decodable { var errorCode: String? }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw ApiError(code: -2, message: "响应解析失败") }
    }

    private func encode(_ body: [String: JSONValue]) throws -> Data { try JSONEncoder().encode(body) }

    func get<T: Decodable>(_ path: String) async throws -> T {
        try decode(await exec(makeRequest(path)))
    }

    func post<T: Decodable>(_ path: String, _ body: [String: JSONValue]) async throws -> T {
        try decode(await exec(makeRequest(path, method: "POST", body: encode(body))))
    }

    private static func enc(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+?#"))) ?? s
    }

    private static func imagesJSON(_ images: [OutImage]) -> JSONValue {
        .array(images.map { .object(["media_type": .string($0.media_type), "data": .string($0.data)]) })
    }

    // MARK: - 连接检查

    func state() async throws -> StateSnapshot { try await get("/api/state") }

    // MARK: - 收件箱

    func actions() async throws -> [ActionItem] { try await get("/api/actions") }
    func actionState(id: String, state: String, snoozeMin: Int? = nil) async throws -> OkMsg {
        var body: [String: JSONValue] = ["id": .string(id), "state": .string(state)]
        if let snoozeMin { body["snoozeMin"] = .number(Double(snoozeMin)) }
        return try await post("/api/actions/state", body)
    }
    func attention() async throws -> [AttentionItem] { try await get("/api/attention") }
    func routines() async throws -> [RoutineCard] { try await get("/api/routines") }
    func calendarToday() async throws -> [Meeting] { try await get("/api/calendar/today") }
    func routineGenerate(id: String) async throws -> OkMsg { try await post("/api/routines/generate", ["id": .string(id)]) }
    func routineWrite(id: String, date: String) async throws -> OkMsg {
        try await post("/api/routines/write", ["id": .string(id), "date": .string(date)])
    }
    func routineSkip(id: String, date: String) async throws -> OkMsg {
        try await post("/api/routines/skip", ["id": .string(id), "date": .string(date)])
    }

    // MARK: - 任务 / agent 会话

    func tasks() async throws -> [WorkTask] { try await get("/api/tasks") }
    func recentSessions() async throws -> [RecentSession] { try await get("/api/dev/recent") }
    func devMessages(id: String) async throws -> AgentState { try await get("/api/dev/messages?id=" + Self.enc(id)) }
    func devSend(id: String, text: String, images: [OutImage] = []) async throws -> OkMsg {
        var body: [String: JSONValue] = ["id": .string(id), "text": .string(text)]
        if !images.isEmpty { body["images"] = Self.imagesJSON(images) }
        return try await post("/api/dev/send", body)
    }
    func devInterrupt(id: String) async throws -> OkMsg { try await post("/api/dev/interrupt", ["id": .string(id)]) }

    /// 跨引擎接力：当前会话保留，新引擎接力续跑（POST /api/dev/handoff，reason 固定 manual）。
    /// 旧 Run 结果未知时服务端回 errorCode=SESSION_HANDOFF_UNKNOWN_CONFIRM_REQUIRED，
    /// 用户确认后带 confirmUnknownOutcome=true 重发（android data/OwnwardClient.kt 同款）。
    func devHandoff(id: String, providerId: String, confirmUnknownOutcome: Bool = false) async throws -> OkMsg {
        try await post("/api/dev/handoff", [
            "id": .string(id), "providerId": .string(providerId),
            "reason": .string("manual"), "confirmUnknownOutcome": .bool(confirmUnknownOutcome),
        ])
    }

    /// 接管租约：take = 取得输入权（ownward），release = 交还只旁观（observing）。
    /// Run 执行中 take 会被拒（SESSION_CONTROL_BUSY），msg 可直接展示。
    func devControl(id: String, action: String) async throws -> ControlResult {
        try await post("/api/dev/control", ["id": .string(id), "action": .string(action)])
    }

    /// 撤回一条还没发出的排队消息。只能按 queueId 撤、不能按下标——手里的队列是轮询快照，
    /// 下标随时会因为本轮结束、队列合并发出而错位。
    /// 撤不到服务端回 409（"这条已经发出…"）并抛 ApiError 带中文原因——不许当成撤成功。
    func devQueueRemove(id: String, queueId: String) async throws -> OkMsg {
        try await post("/api/dev/queue", ["id": .string(id), "action": .string("remove"), "queueId": .string(queueId)])
    }

    func devDecision(id: String, requestId: String, allow: Bool, message: String? = nil, remember: String? = nil) async throws -> OkMsg {
        var body: [String: JSONValue] = ["id": .string(id), "requestId": .string(requestId), "allow": .bool(allow)]
        if let message { body["message"] = .string(message) }
        if let remember { body["remember"] = .string(remember) }
        return try await post("/api/dev/decision", body)
    }

    // MARK: - 外部会话：旁观 + 接管（对齐 web/tasks.js 的 CC 旁观区）

    func ccSessions() async throws -> [ObservedSession] { try await get("/api/cc/sessions") }

    /// 增量读：after 传上次 offset；首帧传 0。长会话首帧会截断前文（truncated）
    func ccSession(id: String, after: Int64) async throws -> CcPage {
        try await get("/api/cc/session?id=" + Self.enc(id) + "&after=\(after)")
    }

    /// terminal 任务 → 底层 Claude 会话 id（还没落盘时 ok=false，稍后重试）
    func taskCcSession(taskId: String) async throws -> TaskCcSession {
        try await get("/api/tasks/" + Self.enc(taskId) + "/cc-session")
    }

    /// 接管外部会话两步走：先签一次性凭证（会话空闲、cwd 还在才签得出），再拿凭证接管成 ownward 任务。
    /// 成功体同 /api/work：{ok, msg, task}，task.id 即新会话，可直接进详情续聊。
    func ccAdoptCapability(id: String) async throws -> AdoptCapability {
        try await post("/api/cc/adopt-capability", ["id": .string(id)])
    }
    func ccAdopt(id: String, adoptToken: String) async throws -> DispatchResult {
        try await post("/api/cc/adopt", ["id": .string(id), "adoptToken": .string(adoptToken)])
    }
    /// terminal 任务一键接管到引擎（Terminal 里的会话必须已空闲，否则 409）
    func adoptTerminal(taskId: String) async throws -> DispatchResult {
        try await post("/api/task/adopt-terminal", ["id": .string(taskId)])
    }

    // MARK: - 派新任务

    /// POST /api/work（契约 src/verticals.ts scopedTasks.startWork：键白名单严格，多一个未知键整包 400）。
    /// 固定 bg=true：手机端没有 terminal 通道。provider 只认 claude/codex/codebuddy；
    /// 成功体 {ok, msg, task}，task 形状随服务端演进，只取 id（taskId）。
    func dispatchWork(dir: String, task: String, provider: String, worktree: Bool,
                      model: String?, permission: String?, images: [OutImage] = []) async throws -> DispatchResult {
        var body: [String: JSONValue] = [
            "dir": .string(dir), "task": .string(task), "bg": .bool(true),
            "provider": .string(provider), "worktree": .bool(worktree),
        ]
        if let model, !model.isEmpty { body["model"] = .string(model) }
        if let permission, !permission.isEmpty { body["permission"] = .string(permission) }
        if !images.isEmpty { body["images"] = Self.imagesJSON(images) }
        return try await post("/api/work", body)
    }

    func projects() async throws -> [ProjectDir] { try await get("/api/projects") }

    /// /api/fs/dirs 的 query 拼接（android fsDirsPath 同款，可单测）：空/空白路径 = 授权根视图
    static func fsDirsPath(_ path: String?) -> String {
        guard let p = path, !p.trimmingCharacters(in: .whitespaces).isEmpty else { return "/api/fs/dirs" }
        return "/api/fs/dirs?path=" + enc(p)
    }
    func fsDirs(path: String? = nil) async throws -> FsDirListing { try await get(Self.fsDirsPath(path)) }

    // MARK: - 对话

    func chatList() async throws -> [AiChat] { try await get("/api/chat/list") }
    func chatMessages(id: String) async throws -> AiChat { try await get("/api/chat/messages?id=" + Self.enc(id)) }
    func chatProviders() async throws -> [String: [String]] { try await get("/api/chat/providers") }
    func chatRename(id: String, title: String) async throws -> OkMsg {
        try await post("/api/chat/rename", ["id": .string(id), "title": .string(title)])
    }
    func chatDelete(id: String) async throws -> OkMsg { try await post("/api/chat/delete", ["id": .string(id)]) }
    func chatImageURL(chatId: String, imageId: String) -> URL {
        url("/api/chat/image?chat_id=\(Self.enc(chatId))&id=\(Self.enc(imageId))")
    }

    /// 发消息，NDJSON 流。收不到 .done 说明服务端没落盘，调用方必须回滚乐观气泡
    /// （契约见 src/chat.ts：出错时服务端弹掉用户消息并删附件）。
    func chatSend(chatId: String?, text: String, provider: String, model: String, images: [OutImage] = []) -> AsyncThrowingStream<ChatEvent, Error> {
        var body: [String: JSONValue] = ["text": .string(text), "provider": .string(provider), "model": .string(model)]
        if let chatId { body["chat_id"] = .string(chatId) }
        if !images.isEmpty { body["images"] = Self.imagesJSON(images) }
        let req: URLRequest
        do { req = makeRequest("/api/chat/send", method: "POST", body: try encode(body)) }
        catch { return AsyncThrowingStream { $0.finish(throwing: error) } }
        let session = streamSession
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, resp) = try await session.bytes(for: req)
                    guard let http = resp as? HTTPURLResponse else { throw ApiError(code: -1, message: "无效响应") }
                    if !(200..<300).contains(http.statusCode) {
                        var data = Data()
                        for try await b in bytes { data.append(b) }
                        throw ApiError(code: http.statusCode, message: self.failMessage(code: http.statusCode, body: data))
                    }
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        guard let ev = try Self.parseChatEvent(line) else { continue }
                        continuation.yield(ev)
                        // 错误帧即终帧（android chatSend 同款）：服务端出错后不会再有有效帧
                        if case .error = ev { break }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private struct ChatFrame: Decodable {
        var type: String
        var text: String?
        var msg: String?
        var chat: JSONValue?      // done 帧的会话体单独二次解码，区分「缺数据」和「格式错」
    }

    /// 一行 NDJSON → 事件；空行跳过（nil）。坏行/未知帧/缺数据的 done 帧不再静默吞——
    /// 直接抛错让调用方回滚乐观气泡（android OwnwardClient.chatSend 同款严格口径）
    static func parseChatEvent(_ line: String) throws -> ChatEvent? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        // 坏行跳过（对齐 web/chat.js 与 android）：daemon 是唯一写入方且写干净 JSON，坏行多为
        // 未来新增的帧格式；杀掉整条流会回滚用户消息，前向兼容代价太大
        guard let f = try? JSONDecoder().decode(ChatFrame.self, from: Data(trimmed.utf8)) else { return nil }
        switch f.type {
        case "delta": return .delta(f.text ?? "")
        case "tool": return .tool(f.text ?? "")
        case "error":
            let m = f.msg ?? ""
            return .error(m.isEmpty ? "对话服务返回错误" : m)
        case "done":
            // done 是终帧，必须带会话体——缺/坏则抛错回滚（这不是前向兼容问题，是协议完整性）
            guard let chatJSON = f.chat, chatJSON != .null else {
                throw ApiError(code: -2, message: "对话完成帧缺少会话数据")
            }
            guard let data = try? JSONEncoder().encode(chatJSON),
                  let chat = try? JSONDecoder().decode(AiChat.self, from: data) else {
                throw ApiError(code: -2, message: "对话完成帧格式错误")
            }
            return .done(chat)
        default:
            return nil   // 未知帧跳过：服务端加新事件类型不该杀掉老客户端的整条流（前向兼容）
        }
    }

    // MARK: - 应用自更新

    func appRelease() async throws -> AppRelease { try await get("/api/app/ios") }

    // MARK: - 带鉴权的图片

    nonisolated(unsafe) private static let imageCache = NSCache<NSURL, NSData>()

    func imageData(_ url: URL) async throws -> Data {
        if let hit = Self.imageCache.object(forKey: url as NSURL) { return hit as Data }
        var req = URLRequest(url: url)
        if let (k, v) = authHeader { req.setValue(v, forHTTPHeaderField: k) }
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw ApiError(code: (resp as? HTTPURLResponse)?.statusCode ?? -1, message: "图片加载失败")
        }
        Self.imageCache.setObject(data as NSData, forKey: url as NSURL, cost: data.count)
        return data
    }
}
