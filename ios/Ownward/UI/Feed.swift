// 会话流的折叠规则（对齐 android ui/Feed.kt）。纯逻辑、不碰 SwiftUI——渲染在 Components.swift，
// 这里只管「怎么分组」，好让它能直接跑单测（分组错了会让 ForEach 的 id 撞车，肉眼看不出来）。
import Foundation

/// 会话流的一项：一条普通消息，或一段被折叠起来的连续工具调用。
/// index 是它在原始 messages 里的正序起点下标——ForEach 的 id 用它：
/// 尾部那组会一直长大，但起点不动，增量追加时旧项不换位。
enum FeedItem: Identifiable, Equatable, Sendable {
    case one(index: Int, msg: DevMsg)
    case tools(index: Int, msgs: [DevMsg])

    var index: Int {
        switch self {
        case .one(let i, _): i
        case .tools(let i, _): i
        }
    }
    var id: Int { index }
}

/// 把连续的工具调用折成一组。
///
/// 为什么折：一轮任务动辄几十次 Edit/Bash/Read，一条一行能把整屏刷满，
/// 而这段时间用户真正想知道的只有三件事——还在跑吗、跑到第几步、有没有出错。
/// 路径和参数是要用的时候才展开的东西，不是默认要占屏幕的东西。
///
/// 少于 minRun 条不折：两三行本来就不碍事，折起来反而多一次点击。
/// 图片行（agent 的截图/读图）不折也不进组，它是内容不是过程——夹在中间就把这段执行断开，
/// 宁可多分一组，也不把消息顺序重排：顺序被动过的流，看的人没法信任。
///
/// 两条不变量（有测试盯着）：每一项的 index 唯一且严格递增；展开后逐条还原就是原列表。
func foldToolRuns(_ msgs: [DevMsg], minRun: Int = 3) -> [FeedItem] {
    func foldable(_ i: Int) -> Bool { msgs[i].role == "tool" && msgs[i].name != "image" }
    var out: [FeedItem] = []
    out.reserveCapacity(msgs.count)
    var i = 0
    while i < msgs.count {
        guard foldable(i) else { out.append(.one(index: i, msg: msgs[i])); i += 1; continue }
        var j = i + 1
        while j < msgs.count, foldable(j) { j += 1 }
        if j - i >= minRun { out.append(.tools(index: i, msgs: Array(msgs[i..<j]))) }
        else { for k in i..<j { out.append(.one(index: k, msg: msgs[k])) } }
        i = j
    }
    return out
}

extension DevMsg {
    /// ⚠️ 出错 / ⛔ 已拒绝：服务端用这两个前缀标失败的工具行（agent-session.ts、runner-consumer.ts）
    var isToolError: Bool { name.map { $0.hasPrefix("⚠️") || $0.hasPrefix("⛔") } ?? false }

    /// 显示用的工具名：空名一律当 "tool"，口径必须和 web/feed.js 的 `m.name || "tool"` 一字不差
    var toolLabel: String { name.flatMap { $0.isEmpty ? nil : $0 } ?? "tool" }
}

/// 折叠组收起时的副标题。
/// 还在跑就显示当前这条（一眼看出卡在哪）；跑完了显示这段都干了什么，按次数取前 3 类。
func toolRunSubtitle(_ msgs: [DevMsg], live: Bool) -> String {
    guard let last = msgs.last else { return "" }
    if live {
        let head = last.text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
        return "\(last.toolLabel) \(head)".trimmingCharacters(in: .whitespaces)
    }
    // 次数降序；并列时保持首次出现的顺序。Swift 的 sorted 不保证稳定，所以把首次出现下标
    // 显式写进比较键——不写就会在并列时随机漂，和 Kotlin/JS 那两端对不上
    var order: [String] = []
    var counts: [String: Int] = [:]
    for m in msgs where !m.isToolError {
        let k = m.toolLabel
        if counts[k] == nil { order.append(k) }
        counts[k, default: 0] += 1
    }
    let kinds = order.enumerated()
        .sorted { a, b in
            let (ca, cb) = (counts[a.element] ?? 0, counts[b.element] ?? 0)
            return ca == cb ? a.offset < b.offset : ca > cb
        }
        .map { (name: $0.element, count: counts[$0.element] ?? 0) }
    let head = kinds.prefix(3).map { $0.count > 1 ? "\($0.name) ×\($0.count)" : $0.name }.joined(separator: " · ")
    return head + (kinds.count > 3 ? " …" : "")
}
