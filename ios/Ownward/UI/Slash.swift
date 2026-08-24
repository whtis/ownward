// 斜杠命令补全的匹配规则（对齐 web/app.js 的 bindComposer + android ui/Slash.kt）。
// 纯逻辑、不碰 SwiftUI，好让「整条是 /词 才提示」「命中排序」这套口径能直接跑单测——
// 三端各写各的匹配，迟早漂成三种行为。
import Foundation

struct SlashCmd: Equatable, Hashable, Identifiable, Sendable {
    let name: String
    let desc: String
    var id: String { name }
}

enum Slash {
    /// ownward 自己解释的命令（/new、/clear 由 workbench.ts 的 /api/dev/send 拦下，
    /// /btw 由忙时输入队列识别）；其余 / 开头一律原样透传给 agent，认识的执行、不认识的回说明
    static let local: [SlashCmd] = [
        SlashCmd(name: "new", desc: "同任务丢上下文重开"),
        SlashCmd(name: "clear", desc: "同 /new"),
        SlashCmd(name: "btw", desc: "忙时补一句背景，不打断本轮"),
    ]

    /// 只在「整条输入就是一个 / 开头的词」时提示（web 的 /^\/(\S*)$/）：
    /// 打出空格 = 命令已选定，开始写参数了，这时候还弹菜单只会挡住正文。
    /// 返回 nil = 不该弹菜单；返回 "" = 刚打了个 "/"，全表都算命中。
    static func query(_ input: String) -> String? {
        guard input.hasPrefix("/") else { return nil }
        let rest = input.dropFirst()
        guard !rest.contains(where: { $0.isWhitespace }) else { return nil }
        return String(rest)
    }

    /// 候选表：本地命令在前，服务端下发的 slash_commands 去重接在后面（同名以本地的说明为准）。
    /// commands 为 nil 表示这个输入框不该有补全（非 claude 引擎 / AI 对话）。
    static func all(_ commands: [String]?) -> [SlashCmd]? {
        guard let commands else { return nil }
        let localNames = Set(local.map(\.name))
        return local + commands.filter { !localNames.contains($0) }.map { SlashCmd(name: $0, desc: "") }
    }

    /// 命中项。包含即命中（忽略大小写），前缀命中排前面，其次按名字排——最多 40 条。
    static func matches(input: String, commands: [String]?) -> [SlashCmd] {
        guard let all = all(commands), let q = query(input) else { return [] }
        let lower = q.lowercased()
        return all
            // 空查询（刚打了个 "/"）必须全放行。不能直接 contains("")——Swift 的 String.contains
            // 走 range(of:)，空串返回 **false**，而 Kotlin 的 contains 和 JS 的 includes 都返回 true。
            // 照抄那两端的写法，结果就是打完 "/" 菜单一条不弹（有测试盯着）
            .filter { lower.isEmpty || $0.name.lowercased().contains(lower) }
            .enumerated()
            .sorted { a, b in
                let (pa, pb) = (a.element.name.lowercased().hasPrefix(lower), b.element.name.lowercased().hasPrefix(lower))
                if pa != pb { return pa }
                if a.element.name != b.element.name { return a.element.name < b.element.name }
                return a.offset < b.offset      // 名字也相同：保持候选表原序，排序结果才是确定的
            }
            .map(\.element)
            .prefix(40)
            .map { $0 }
    }

    /// 选中一条：整条输入换成 "/name "，光标落在末尾直接写参数
    static func accept(_ cmd: SlashCmd) -> String { "/\(cmd.name) " }
}
