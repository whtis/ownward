// 触感反馈集中管理（ChatGPT iOS 的手感：发送轻击、返回轻击、完成成功、错误警告、选择滴答）。
// 模拟器没有触感引擎，调用无害；真机上生效。
import UIKit

@MainActor
enum Haptics {
    private static let light = UIImpactFeedbackGenerator(style: .light)
    private static let medium = UIImpactFeedbackGenerator(style: .medium)
    private static let soft = UIImpactFeedbackGenerator(style: .soft)
    private static let rigid = UIImpactFeedbackGenerator(style: .rigid)
    private static let selectionGen = UISelectionFeedbackGenerator()
    private static let notifyGen = UINotificationFeedbackGenerator()

    /// 点按/发送/返回：轻
    static func tap() { light.impactOccurred(intensity: 0.8) }
    /// 主动作（发送、批准）：中
    static func action() { medium.impactOccurred() }
    /// 柔和（流式开始/结束）
    static func soft(_ intensity: CGFloat = 0.6) { Self.soft.impactOccurred(intensity: intensity) }
    /// 返回上一级（NavigationStack pop）
    static func back() { rigid.impactOccurred(intensity: 0.45) }
    static func selection() { selectionGen.selectionChanged() }
    static func success() { notifyGen.notificationOccurred(.success) }
    static func warning() { notifyGen.notificationOccurred(.warning) }
    static func error() { notifyGen.notificationOccurred(.error) }
}
