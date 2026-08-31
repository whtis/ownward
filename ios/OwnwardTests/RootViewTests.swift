import Foundation
import Testing
@testable import Ownward

struct RootViewTests {
    private func defaults() -> UserDefaults {
        UserDefaults(suiteName: "RootViewTests.\(UUID().uuidString)")!
    }

    @Test func 缺失或损坏的偏好仍从新对话启动() {
        let defaults = defaults()
        let preference = AppTabPreference(defaults: defaults)
        #expect(preference.initialTab() == .chat)

        defaults.set("unknown", forKey: AppTabPreference.key)
        #expect(preference.initialTab() == .chat)
    }

    @Test func 收件箱和Agent选择能跨MainShell重建恢复() {
        let defaults = defaults()
        AppTabPreference(defaults: defaults).save(.inbox)
        #expect(AppTabPreference(defaults: defaults).initialTab() == .inbox)

        AppTabPreference(defaults: defaults).save(.agent)
        #expect(AppTabPreference(defaults: defaults).initialTab() == .agent)
    }

    @Test func 调试入口仅临时覆盖且不会改写偏好() {
        let defaults = defaults()
        let preference = AppTabPreference(defaults: defaults)
        preference.save(.agent)

        #expect(preference.initialTab(debugOverride: "inbox") == .inbox)
        #expect(preference.initialTab() == .agent)
        #expect(preference.initialTab(debugOverride: "invalid") == .agent)
    }
}
