// Ownward iPhone 端：手机场景只做「人不在电脑前」的三件事——收件箱审批/回答、agent 会话续聊、AI 对话。
// 与 android/ 同一套 daemon API、同一套色板与交互语法；iOS 26 起步（Liquid Glass、tab 栏下滑收起）。
import SwiftUI

@main
struct OwnwardApp: App {
    @State private var settings = AppSettings()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(settings)
                .tint(OW.accent)
        }
    }
}
