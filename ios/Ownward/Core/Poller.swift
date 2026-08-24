// 生命周期感知轮询（对齐 android Components.kt 的 Poller）：只在 app 前台且视图在屏时跑，
// 间隔由每轮 tick 返回（运行中 2.5s / 空闲 8s 这种动态节奏），抛错则 8s 退避。
import SwiftUI

private struct PollKey: Hashable {
    let id: AnyHashable
    let active: Bool
}

private struct PollModifier: ViewModifier {
    let id: AnyHashable
    let tick: @MainActor () async throws -> Duration
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content.task(id: PollKey(id: id, active: scenePhase == .active)) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                let wait: Duration
                do { wait = try await tick() } catch { wait = .seconds(8) }
                do { try await Task.sleep(for: wait) } catch { return }
            }
        }
    }
}

extension View {
    func poll(id: some Hashable & Sendable, _ tick: @escaping @MainActor () async throws -> Duration) -> some View {
        modifier(PollModifier(id: AnyHashable(id), tick: tick))
    }
}
