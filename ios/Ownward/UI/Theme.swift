// ChatGPT 式近单色色板（与 android ui/theme/Theme.kt 同值）：低噪声、层级靠留白与字重，
// 蓝色只用于焦点/链接/状态。动态色随系统深浅切换。
import SwiftUI
import UIKit

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// Ownward 色板：`OW.bg`、`OW.accent`…
enum OW {
    private static func dyn(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
    static let bg = dyn(0xFFFFFF, 0x0D0D0E)
    static let surface1 = dyn(0xF6F6F7, 0x171719)
    static let surface2 = dyn(0xEFEFF1, 0x212124)
    static let surface3 = dyn(0xE7E7EA, 0x2A2A2E)
    static let userBubble = dyn(0xECECEE, 0x2B2B2F)
    static let text = dyn(0x1A1A1E, 0xF1F1F2)
    static let textDim = dyn(0x70707A, 0xA1A1A8)
    static let outline = dyn(0xD8D8DE, 0x343438)
    static let outlineFaint = dyn(0xE9E9EE, 0x29292C)
    static let accent = dyn(0x2E6BD6, 0x63A8FF)
    static let success = dyn(0x178A56, 0x56C991)
    static let warn = dyn(0x9A7A16, 0xE4B85B)
    static let danger = dyn(0xCC3D52, 0xF0717E)
}

/// 排版 token（android OwnwardType）：消息正文 16/24、列表正文 15/21、辅助 13/18，
/// 标题靠字重不靠加粗放大；空态问候 28/34。lineSpacing = 行高 - 字号默认行高（≈1.2×）。
extension Font {
    static let owBody = Font.system(size: 16)
    static let owBodyM = Font.system(size: 15)
    static let owBodyS = Font.system(size: 13)
    static let owLabel = Font.system(size: 13, weight: .medium)
    static let owLabelM = Font.system(size: 12, weight: .medium)
    static let owLabelS = Font.system(size: 11, weight: .medium)
    static let owTitle = Font.system(size: 20, weight: .semibold)
    static let owTitleM = Font.system(size: 17, weight: .semibold)
    static let owTitleS = Font.system(size: 15, weight: .medium)
    static let owHeadline = Font.system(size: 28, weight: .medium)
    static let owMono = Font.system(size: 13, design: .monospaced)
    static let owMonoS = Font.system(size: 11, design: .monospaced)
}

extension View {
    /// 消息正文：16pt / 行高 24
    func messageBody() -> some View { font(.owBody).lineSpacing(5) }
    /// 列表正文：15pt / 行高 21
    func listBody() -> some View { font(.owBodyM).lineSpacing(3) }
    /// 辅助文字：13pt / 行高 18
    func caption() -> some View { font(.owBodyS).lineSpacing(2).foregroundStyle(OW.textDim) }
}

/// 圆角 token：6/8/12/16/24
enum OWRadius {
    static let xs: CGFloat = 6, s: CGFloat = 8, m: CGFloat = 12, l: CGFloat = 16, xl: CGFloat = 24
}
