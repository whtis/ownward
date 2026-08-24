// 对话列表：标题 + 供应商·模型 + 时间；右上角新对话；左滑删除。
// 行样式与搜索口径和侧边栏、Agent 页共用（EntityRow + searchHit），三处不会各走各的。
import SwiftUI

struct ChatListView: View {
    let client: OwnwardClient
    let openChat: (String?) -> Void
    @State private var chats: [AiChat] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var confirmDelete: AiChat?
    @State private var query = ""

    private var q: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        // 过滤口径与侧边栏逐字一致（标题 + 供应商 + 模型），同一个关键字两处得到同一批结果
        let shown = chats.filter { searchHit(q, $0.title, $0.provider, $0.model) }
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ErrorBanner(message: error)
                ForEach(shown) { chat in
                    EntityRow(
                        title: chat.title.isEmpty ? "未命名对话" : chat.title,
                        sub: sessionSub(chat.provider, chat.model, TimeFormat.ago(iso: chat.updatedAt)),
                        action: { openChat(chat.id) },
                        trailing: {
                            Button { Haptics.warning(); confirmDelete = chat } label: {
                                Image(systemName: "trash").font(.system(size: 14))
                                    .foregroundStyle(OW.textDim).frame(width: 36, height: 36)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("删除")
                        }
                    )
                }
                if loaded, shown.isEmpty, error == nil {
                    EmptyHint(text: q.isEmpty ? "还没有对话，点右上角开始" : "没有匹配「\(q)」的对话")
                }
                Spacer(minLength: 24)
            }
            .padding(.top, 4)
            .animation(.snappy, value: chats)
        }
        .background(OW.bg)
        .navigationTitle("对话")
        .searchable(text: $query, prompt: "搜索对话")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { DrawerMenuButton() }
            ToolbarItem(placement: .topBarTrailing) {
                Button { Haptics.tap(); openChat(nil) } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("新对话")
            }
        }
        .refreshable { Haptics.tap(); await refresh() }
        .poll(id: "chat-list") { await refresh(); return .seconds(60) }
        .alert("删除对话", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })) {
            Button("删除", role: .destructive) {
                guard let chat = confirmDelete else { return }
                confirmDelete = nil
                Task { _ = try? await client.chatDelete(id: chat.id); Haptics.success(); await refresh() }
            }
            Button("取消", role: .cancel) { confirmDelete = nil }
        } message: {
            Text("删除「\(confirmDelete?.title.isEmpty == false ? confirmDelete!.title : "未命名对话")」？附件也会一并删除。")
        }
    }

    private func refresh() async {
        do { chats = try await client.chatList(); error = nil }
        catch { self.error = error.userMessage }
        loaded = true
    }
}
