// 会话列表的归并口径（对齐 android ui/AgentScreen.kt 的 externalSessions、web/tasks.js 的同名函数）。
// 纯逻辑、不碰 SwiftUI：Agent 页和侧边栏共用同一套，两处列表不会打架，也好直接跑单测。
import Foundation

/// web/tasks.js tkNorm 同款：任务原文与外部会话首条 user 消息归一后比对，
/// 认出「其实是 ownward 派的」会话
private func norm(_ s: String) -> String {
    let collapsed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return String(collapsed.prefix(60))
}

/// 本机外部会话 = 去掉「其实就是 ownward 任务」的那些（web externalSessions 同款）：
/// terminal 已认领的 + 首条 user 消息与任务原文同头的。活跃优先、其次按最近写入排。
func externalSessions(tasks: [WorkTask], ccList: [ObservedSession]) -> [ObservedSession] {
    let claimed = Set(tasks.compactMap(\.ccSessionId))
    let heads = Set(tasks.map { norm($0.task) })
    var seen = Set<String>()
    return ccList
        .filter { s in
            let last = s.id.split(separator: "/").last.map(String.init) ?? s.id
            guard !claimed.contains(last), !claimed.contains(s.id) else { return false }
            return !(!s.firstUser.isEmpty && heads.contains(norm(s.firstUser)))
        }
        .filter { seen.insert($0.id).inserted }   // distinctBy { id }
        .sorted { a, b in a.active == b.active ? a.mtime > b.mtime : a.active }
}
