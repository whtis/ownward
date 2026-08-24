// 与 daemon 的契约一一对应（src/actions.ts、src/kernel/sessions/service.ts、src/chat.ts 等），
// 字段名与 android/app/.../data/Models.kt 保持一致。服务端字段会演进：缺字段/null 一律落默认值
// （@Defaulted），未知字段忽略（Codable 默认行为）。
import Foundation

// MARK: - 缺省值解码

protocol DefaultValue { static var defaultValue: Self { get } }
extension String: DefaultValue { static var defaultValue: String { "" } }
extension Int: DefaultValue { static var defaultValue: Int { 0 } }
extension Int64: DefaultValue { static var defaultValue: Int64 { 0 } }
extension Double: DefaultValue { static var defaultValue: Double { 0 } }
extension Bool: DefaultValue { static var defaultValue: Bool { false } }
extension Array: DefaultValue { static var defaultValue: [Element] { [] } }

/// `@Defaulted var title: String`：键缺失、值为 null 或类型不匹配时取类型默认值，对齐 Kotlin 的默认参数。
@propertyWrapper
struct Defaulted<T: Decodable & DefaultValue>: Decodable {
    var wrappedValue: T
    init(wrappedValue: T) { self.wrappedValue = wrappedValue }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        wrappedValue = (try? c.decode(T.self)) ?? T.defaultValue
    }
}
extension Defaulted: Sendable where T: Sendable {}
extension Defaulted: Equatable where T: Equatable {}
extension Defaulted: Hashable where T: Hashable {}
extension KeyedDecodingContainer {
    func decode<T>(_ type: Defaulted<T>.Type, forKey key: Key) throws -> Defaulted<T> {
        (try? decodeIfPresent(Defaulted<T>.self, forKey: key)) ?? Defaulted(wrappedValue: T.defaultValue)
    }
}

/// 任意 JSON（权限请求的 input 形状由工具决定）
indirect enum JSONValue: Codable, Equatable, Hashable, Sendable {
    case string(String), number(Double), bool(Bool), null
    case array([JSONValue]), object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON") }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
    subscript(key: String) -> JSONValue? { if case .object(let o) = self { return o[key] } else { return nil } }
    var stringValue: String? { if case .string(let s) = self { return s } else { return nil } }
    var boolValue: Bool? {
        switch self { case .bool(let b): return b; case .string(let s): return s == "true"; default: return nil }
    }
    var arrayValue: [JSONValue]? { if case .array(let a) = self { return a } else { return nil } }
}

// MARK: - 状态 / 今日

struct StateSnapshot: Decodable, Sendable, Equatable {
    @Defaulted var now: String
    @Defaulted var pid: Int64
    @Defaulted var queue: Int
    var vaultToday: String?
    @Defaulted var allowFullAccess: Bool          // architecture.allowFullAccess：bypass 权限的服务端门
    @Defaulted var dispatchDefaults: DispatchDefaults   // config dispatch.defaults（派任务预填，前端不硬编码）
}

/// config dispatch.defaults = {dir, model, permission, codex, provider}，字段全可缺
struct DispatchDefaults: Decodable, Sendable, Equatable {
    var dir: String?
    var model: String?
    var permission: String?   // safe | bypass
    var codex: Bool?          // 旧开关；provider 优先
    var provider: String?     // claude | codex | codebuddy
    init() {}
}
extension DispatchDefaults: DefaultValue { static var defaultValue: DispatchDefaults { DispatchDefaults() } }

/// POST /api/work、/api/cc/adopt、/api/task/adopt-terminal 的成功体：{ok, msg, task}。
/// task 是完整 WorkTask，形状随服务端演进——只取 id，别整包强类型
struct DispatchResult: Decodable, Sendable, Equatable {
    @Defaulted var ok: Bool
    @Defaulted var msg: String
    var task: JSONValue?
    var taskId: String? { task?["id"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } }
}

struct ProjectDir: Decodable, Sendable, Equatable, Hashable, Identifiable {
    @Defaulted var name: String
    @Defaulted var dir: String
    var id: String { dir }
}

struct ActionRef: Decodable, Sendable, Equatable {
    var chat_id: String?
    var task_id: String?
    var url: String?
    var mail_id: String?
    var note: String?
    init() {}
}
extension ActionRef: DefaultValue { static var defaultValue: ActionRef { ActionRef() } }

struct ActionItem: Decodable, Sendable, Equatable, Identifiable {
    var id: String
    @Defaulted var kind: String      // reply | review | approve | follow_up | decide
    @Defaulted var source: String
    @Defaulted var title: String
    @Defaulted var reason: String
    @Defaulted var state: String     // open | snoozed | processing | resolved | dismissed
    @Defaulted var createdAt: String
    @Defaulted var updatedAt: String
    var snoozedUntil: String?
    @Defaulted var ref: ActionRef

    var kindLabel: String {
        switch kind {
        case "reply": "回复"; case "review": "评审"; case "approve": "审批"
        case "follow_up": "跟进"; case "decide": "决策"; default: kind
        }
    }
}

struct AttentionItem: Decodable, Sendable, Equatable, Identifiable {
    var taskId: String
    @Defaulted var project: String
    @Defaulted var backend: String
    @Defaulted var kind: String      // stuck | done
    @Defaulted var title: String
    @Defaulted var detail: String
    @Defaulted var age: Int64
    @Defaulted var since: Int64
    var id: String { taskId }
}

struct RoutineCard: Decodable, Sendable, Equatable, Identifiable {
    var id: String
    @Defaulted var name: String
    @Defaulted var time: String
    @Defaulted var date: String
    @Defaulted var isToday: Bool
    @Defaulted var overdue: Bool
    @Defaulted var nextLabel: String
    @Defaulted var daysUntil: Int
    @Defaulted var status: String    // pending | draft | writing | written | skipped | upcoming
    @Defaulted var hasDraft: Bool
    var taskId: String?
    @Defaulted var stale: Bool
}

struct Meeting: Decodable, Sendable, Equatable, Hashable {
    @Defaulted var id: String
    @Defaulted var title: String
    @Defaulted var start: String
    @Defaulted var end: String
    var organizer: String?
    var meetingUrl: String?
}

// MARK: - 任务 / agent 会话

struct WorkTask: Decodable, Sendable, Equatable, Identifiable {
    var id: String
    @Defaulted var project: String
    var projectDir: String?
    @Defaulted var cwd: String
    @Defaulted var task: String
    var title: String?
    @Defaulted var mode: String      // terminal | claude-bg | codex-bg
    var engine: Bool?
    var model: String?
    @Defaulted var status: String    // running | exited | done
    @Defaulted var startedAt: String
    var endedAt: String?
    var exitCode: Int?
    var ccSessionId: String?         // terminal 任务认领到的底层 Claude 会话（旁观/接管到引擎用）
}

struct RecentSession: Decodable, Sendable, Equatable, Identifiable {
    var id: String
    @Defaulted var project: String
    @Defaulted var title: String
    @Defaulted var mode: String
    @Defaulted var status: String
    @Defaulted var startedAt: String
    @Defaulted var lastAt: Int64     // epoch ms
    @Defaulted var msgs: Int
    @Defaulted var userMsgs: Int
    @Defaulted var last: String
}

struct DevMsg: Decodable, Sendable, Equatable, Hashable {
    var role: String                 // user | assistant | tool | system | thinking
    @Defaulted var text: String
    var name: String?                // name="image" 的 tool 消息 = 图片行
    @Defaulted var ts: String
    var images: [String]?            // /api/agent-image/... 绝对路径
}

struct PendingPerm: Decodable, Sendable, Equatable, Hashable, Identifiable {
    var requestId: String
    @Defaulted var toolName: String
    var input: JSONValue?
    @Defaulted var at: Int64
    @Defaulted var brief: String
    var id: String { requestId }
}

struct PlanStep: Decodable, Sendable, Equatable, Hashable {
    @Defaulted var text: String
    @Defaulted var status: String    // pending | in_progress | completed
}

struct TokenUsage: Decodable, Sendable, Equatable {
    var input: Int64?
    var output: Int64?
    var total: Int64?
}

struct QueuedView: Decodable, Sendable, Equatable, Hashable, Identifiable {
    // 撤回按 id 认人（服务端只收 queueId，不收下标）。老 daemon 不带 id → 空串，
    // 这种时候不画撤回钮：撤不了就别摆按钮
    @Defaulted var id: String
    @Defaulted var text: String
    @Defaulted var btw: Bool
    @Defaulted var images: Int
}

/// 释放输入权后在别的终端续聊的命令（kernel/sessions/contracts.ts）
struct ResumeInfo: Decodable, Sendable, Equatable {
    @Defaulted var id: String
    @Defaulted var tool: String
    @Defaulted var cmd: String
}

/// POST /api/dev/control 回执：control 是切换后的租约状态
struct ControlResult: Decodable, Sendable, Equatable {
    @Defaulted var ok: Bool
    @Defaulted var control: String
    @Defaulted var msg: String
}

struct AgentState: Decodable, Sendable, Equatable {
    @Defaulted var messages: [DevMsg]
    @Defaulted var turn: String          // running | idle
    @Defaulted var alive: Bool
    @Defaulted var partial: String
    @Defaulted var pending: [PendingPerm]
    @Defaulted var backend: String
    @Defaulted var control: String       // ownward | external | observing
    @Defaulted var queued: [QueuedView]
    @Defaulted var plan: [PlanStep]
    var tokens: TokenUsage?
    var model: String?
    var ctxTokens: Int64?
    @Defaulted var lastActivityAt: Int64
    // Runner 不可达时服务端仍回 200 但标 stale——不显示会让人对着过期快照以为 agent 还在干活
    @Defaulted var stale: Bool
    var errorCode: String?
    @Defaulted var operability: String   // active | read-only
    // provider init 帧回报的 slash_commands（输入框 / 补全用）；codex 之类不回报时为空
    @Defaulted var commands: [String]
    var resume: ResumeInfo?              // 释放输入权后在别的终端续聊的命令

    var isRunning: Bool { turn == "running" }
    var canInput: Bool { control == "ownward" && operability != "read-only" }
}

// MARK: - 外部会话旁观 / 接管

/// GET /api/cc/sessions：本机全部外部 agent 会话（Claude ~/.claude/projects + Codex ~/.codex/sessions 合并）。
/// id 是稳定引用键（claude "<hashDir>/<uuid>"、codex "cdx:<home>:<id>"），含 "/" 和 ":"。
/// kind 只有 codex 会带；缺省即 claude。
struct ObservedSession: Decodable, Sendable, Equatable, Identifiable {
    var id: String
    @Defaulted var cwd: String
    @Defaulted var project: String
    @Defaulted var title: String
    @Defaulted var firstUser: String
    @Defaulted var mtime: Int64          // epoch ms
    @Defaulted var active: Bool          // 2 分钟内有写入 = 正被别的端驱动，此时不能接管
    var kind: String?
    var isCodex: Bool { kind == "codex" }
}

/// GET /api/cc/session?id&after：增量页。offset 回传给下一次 after；
/// 文件缩小（offset < 上次）= 截断重建，需清空累积
struct CcPage: Decodable, Sendable, Equatable {
    // 服务端只在失败时显式写 ok:false，成功体不带这个键——缺省必须视为 true，
    // 否则每一页都被当成读取失败（Kotlin 那边是 `val ok: Boolean = true`）
    private var ok: Bool?
    @Defaulted var msg: String
    @Defaulted var messages: [DevMsg]
    @Defaulted var offset: Int64
    @Defaulted var truncated: Bool
    var isOK: Bool { ok ?? true }
}

/// POST /api/cc/adopt-capability：接管凭证（一次性、短时；会话正在被驱动时 409 DEV_SESSION_DISCOVERY_ACTIVE）
struct AdoptCapability: Decodable, Sendable, Equatable {
    @Defaulted var ok: Bool
    var adoptToken: String?
    @Defaulted var msg: String
    var errorCode: String?
}

/// GET /api/tasks/{id}/cc-session：terminal 任务底层 Claude 会话 id（还没认领到时 ok=false）
struct TaskCcSession: Decodable, Sendable, Equatable {
    @Defaulted var ok: Bool
    var sessionId: String?
    @Defaulted var active: Bool
    @Defaulted var msg: String
}

// MARK: - AI 对话

struct ChatImageMeta: Decodable, Sendable, Equatable, Hashable, Identifiable {
    var id: String
    @Defaulted var mediaType: String
    @Defaulted var bytes: Int64
}

struct AiMessage: Decodable, Sendable, Equatable, Hashable {
    var role: String                 // user | assistant
    @Defaulted var text: String
    @Defaulted var ts: String
    @Defaulted var images: [ChatImageMeta]
    init(role: String, text: String, ts: String, images: [ChatImageMeta] = []) {
        self.role = role; self.text = text; self.ts = ts; self.images = images
    }
}

struct AiChat: Decodable, Sendable, Equatable, Identifiable {
    var id: String
    @Defaulted var title: String
    @Defaulted var provider: String
    @Defaulted var model: String
    @Defaulted var createdAt: String
    @Defaulted var updatedAt: String
    @Defaulted var messages: [AiMessage]
}

/// POST /api/chat/send 的 NDJSON 流事件
enum ChatEvent: Sendable, Equatable {
    case delta(String)
    case tool(String)
    case error(String)
    case done(AiChat)
}

/// 发送图片：裸 base64，无 data: 前缀
struct OutImage: Encodable, Sendable, Equatable, Hashable {
    var media_type: String
    var data: String
}

struct OkMsg: Decodable, Sendable {
    @Defaulted var ok: Bool
    @Defaulted var msg: String
}

/// GET /api/app/ios：daemon 端 data/app/ios.json（由 scripts/ios-release.sh 写入）
struct AppRelease: Decodable, Sendable {
    @Defaulted var ok: Bool
    @Defaulted var versionName: String
    @Defaulted var versionCode: Int
    @Defaulted var notes: String
    var url: String?                 // TestFlight / 自托管安装页，"立即更新" 打开它
}
