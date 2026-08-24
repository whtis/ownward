// 对话滚动容器：ChatGPT 式——内容不满一屏时顶部对齐，满屏后底部锚定（流式增长自动跟随、不抖）；
// 贴近底部才自动跟随（上翻不抢滚动位置），离开底部出现"滚到底部"玻璃圆钮。
import SwiftUI

struct ConversationScroll<Content: View>: View {
    /// 变化即触发一次"若在底部则滚到底"（消息数 + 流式文本长度节流后的值）
    let followKey: Int
    @ViewBuilder let content: () -> Content
    @State private var nearBottom = true
    @State private var viewportHeight: CGFloat = 0   // 容器高度扣掉 safe area bar 后的可见高度
    @State private var contentHeight: CGFloat = 0    // 消息内容实际高度（不含顶部占位）

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        content()
                    }
                    .background(GeometryReader { g in
                        Color.clear
                            .onAppear { contentHeight = g.size.height }
                            .onChange(of: g.size.height) { _, h in contentHeight = h }
                    })
                    // 内容不满一屏：底部锚定会把短内容贴底，用下方占位把内容顶回顶部（ChatGPT 式）；
                    // 内容越长占位越短，满屏后为 0，之后由底部锚定负责流式跟随
                    Color.clear.frame(height: max(0, viewportHeight - contentHeight))
                    Color.clear.frame(height: 1).id("bottom")
                }
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { g in
                g.contentOffset.y + g.containerSize.height >= g.contentSize.height - 140
            } action: { _, new in
                nearBottom = new
            }
            // 可见高度：GeometryReader 给的 frame 已经扣掉 safe area（导航栏 / composer bar / 键盘），首帧即回调
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.size.height
            } action: { h in
                if abs(h - viewportHeight) > 0.5 { viewportHeight = max(0, h) }
            }
            .onChange(of: followKey) {
                if nearBottom { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .overlay(alignment: .bottomTrailing) {
                if !nearBottom {
                    ScrollToBottomButton { withAnimation(.snappy) { proxy.scrollTo("bottom", anchor: .bottom) } }
                        .padding(.trailing, 16).padding(.bottom, 8)
                        .transition(.scale(scale: 0.8).combined(with: .opacity))
                }
            }
            .animation(.snappy(duration: 0.25), value: nearBottom)
        }
    }
}
