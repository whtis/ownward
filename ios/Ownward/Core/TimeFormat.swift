import Foundation

enum TimeFormat {
    // formatter 每次现建：调用频率低（列表行/发送时），省掉共享可变静态的线程问题
    private static func formatter(fractional: Bool) -> ISO8601DateFormatter {
        let f = ISO8601DateFormatter()
        f.formatOptions = fractional ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        return f
    }

    /// 服务端 toISOString / +08:00 偏移都可能出现
    static func parse(_ s: String) -> Date? {
        formatter(fractional: true).date(from: s) ?? formatter(fractional: false).date(from: s)
    }

    static func ago(epochMs: Int64) -> String {
        guard epochMs > 0 else { return "" }
        return ago(Date(timeIntervalSince1970: Double(epochMs) / 1000))
    }

    static func ago(iso s: String) -> String {
        guard let d = parse(s) else { return "" }
        return ago(d)
    }

    static func ago(_ date: Date, now: Date = Date()) -> String {
        let diff = Int(now.timeIntervalSince(date))
        switch diff {
        case ..<60: return "刚刚"
        case ..<3600: return "\(diff / 60) 分钟前"
        case ..<86400: return "\(diff / 3600) 小时前"
        default: return "\(diff / 86400) 天前"
        }
    }

    /// "2026-08-14T09:30:00+08:00" → "09:30"；解析不出就原样返回
    static func clock(_ iso: String) -> String {
        guard let t = iso.firstIndex(of: "T") else { return iso }
        let start = iso.index(after: t)
        guard let end = iso.index(start, offsetBy: 5, limitedBy: iso.endIndex) else { return iso }
        return String(iso[start..<end])
    }

    static func nowISO() -> String { formatter(fractional: true).string(from: Date()) }
}
