// 界面语言。App 现有文案只有中文；新加的文案按 tr(中文, English) 两套给，跟随系统首选语言——
// 口径对齐 web/i18n.js 的 auto：首选语言里有任一中文就用中文，否则英文（android ui/Lang.kt 同口径）。
import Foundation

enum UILang: Sendable, Equatable {
    case zh, en

    static func resolve(_ preferred: [String]) -> UILang {
        preferred.contains { $0.lowercased().hasPrefix("zh") } ? .zh : .en
    }

    static let current = resolve(Locale.preferredLanguages)
}

func tr(_ zh: String, _ en: String) -> String { UILang.current == .zh ? zh : en }
