// AI 对话：NDJSON 流式（delta 走打字机平滑吐字）、供应商·模型切换（仅新对话）、图片附件、
// 乐观气泡（无 done 帧即回滚、还原草稿——对齐 web/chat.js 的事务语义）。
import SwiftUI
import PhotosUI

struct ChatProviderSelection: Equatable {
    var providers: [String: [String]]
    var provider: String
    var model: String
}

struct ChatProviderError: LocalizedError, Equatable {
    let message: String
    var errorDescription: String? { message }
}

/// 选定可用的供应商·模型（android ChatDetailScreen.selectChatProvider 同款，可单测）：
/// 既有对话必须跟随会话已存的 provider/model，不可用就报错而不是悄悄换一个；
/// 新对话先试请求的供应商，不行落到可用表里的第一个（Swift 字典无序，按 key 排序取首个求确定性）。
func selectChatProvider(
    raw: [String: [String]], requestedProvider: String, requestedModel: String, existingChat: Bool
) throws -> ChatProviderSelection {
    let available = raw.filter { !$0.value.isEmpty }
    guard !available.isEmpty else { throw ChatProviderError(message: "服务端没有可用的对话模型") }
    if existingChat {
        guard available[requestedProvider]?.contains(requestedModel) == true else {
            throw ChatProviderError(message: "此对话使用的 \(requestedProvider) · \(requestedModel) 当前不可用")
        }
        return ChatProviderSelection(providers: available, provider: requestedProvider, model: requestedModel)
    }
    if let m = available[requestedProvider]?.first {
        return ChatProviderSelection(providers: available, provider: requestedProvider, model: m)
    }
    let key = available.keys.sorted()[0]
    return ChatProviderSelection(providers: available, provider: key, model: available[key]![0])
}

@MainActor @Observable
final class ChatStore {
    let client: OwnwardClient
    var chatId: String?
    var messages: [AiMessage] = []
    var providers: [String: [String]] = [:]
    // 默认 ChatGPT（codex）：日常快聊的首选；claude 引擎在模型菜单一步可切
    var provider = "codex"
    var model = "default"
    var title = ""
    var streaming = false
    let stream = TypewriterBuffer()
    var toolLine = ""
    var optimisticImages: [UIImage] = []   // 乐观气泡的本地预览（落盘后换服务端版本）
    var error: String?
    var loaded = false
    var loading = true
    var loadError: String?

    init(client: OwnwardClient, chatId: String?) { self.client = client; self.chatId = chatId }

    var isNew: Bool { chatId == nil }

    /// 载入型号表 + 既有对话内容。失败落 loadError（composer 上给「重试」），
    /// 不再静默吞——providers 为空/型号不可用时以前会带着非法组合发出（android 48e984a 同款修复）
    func load() async {
        loading = true
        loadError = nil
        defer { loaded = true; loading = false }
        do {
            let available = try await client.chatProviders()
            if let id = chatId {
                let chat = try await client.chatMessages(id: id)
                messages = chat.messages
                title = chat.title
                let sel = try selectChatProvider(raw: available, requestedProvider: chat.provider,
                                                 requestedModel: chat.model, existingChat: true)
                providers = sel.providers; provider = sel.provider; model = sel.model
            } else {
                let sel = try selectChatProvider(raw: available, requestedProvider: provider,
                                                 requestedModel: model, existingChat: false)
                providers = sel.providers; provider = sel.provider; model = sel.model
            }
        } catch {
            providers = [:]
            loadError = error.userMessage
        }
    }

    /// 型号组合当前可发（对话服务已就绪且选中的 provider/model 在可用表里）
    var canCompose: Bool { !loading && loadError == nil && providers[provider]?.contains(model) == true }

    /// 发送事务。返回 (需要还原的草稿, 图片) —— nil 表示成功落盘
    func send(text: String, images: [PendingImage]) async -> (String, [PendingImage])? {
        // 纯图片发送的默认提示语与后端 defaultImageText（src/chat-images.ts）一致：气泡上写的必须是真落盘的那句
        let body = text.isEmpty ? (images.count > 1 ? "看一下这几张图" : "看一下这张图") : text
        messages.append(AiMessage(role: "user", text: body, ts: TimeFormat.nowISO()))
        optimisticImages = images.map(\.thumbnail)
        streaming = true; stream.reset(); accumulated = ""; toolLine = ""; error = nil
        var gotDone = false
        var gotFirstDelta = false
        do {
            for try await ev in client.chatSend(chatId: chatId, text: text, provider: provider, model: model, images: images.map(\.payload)) {
                switch ev {
                case .delta(let t):
                    if !gotFirstDelta { gotFirstDelta = true; Haptics.soft(0.4) }
                    accumulated += t
                    stream.set(accumulated)
                case .tool(let t): toolLine = t
                case .error(let m): error = m
                case .done(let chat):
                    gotDone = true
                    // 先关流式态再换消息：否则流真正关闭前的那一帧里，持久化回复和流式块会同时在屏
                    streaming = false; stream.reset(); toolLine = ""; optimisticImages = []
                    chatId = chat.id; messages = chat.messages; title = chat.title
                }
            }
        } catch {
            self.error = error.userMessage
        }
        streaming = false
        stream.reset(); toolLine = ""; optimisticImages = []
        if !gotDone {
            // 服务端没落盘：撤回气泡，还原草稿
            if !messages.isEmpty { messages.removeLast() }
            if error == nil { error = "发送中断，草稿已恢复" }
            Haptics.error()
            return (text, images)
        }
        Haptics.soft(0.5)
        return nil
    }

    /// 服务端 delta 是增量，打字机需要完整目标串——这里累积
    private var accumulated = ""
}

struct ChatDetailView: View {
    let client: OwnwardClient
    let chatId: String?
    @State private var store: ChatStore
    @State private var input = ""
    @State private var pendingImages: [PendingImage] = []
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var loadAttempt = 0
    @FocusState private var focused: Bool

    init(client: OwnwardClient, chatId: String?) {
        self.client = client; self.chatId = chatId
        _store = State(initialValue: ChatStore(client: client, chatId: chatId))
    }

    var body: some View {
        let msgs = store.messages
        ConversationScroll(followKey: msgs.count * 1000 + store.stream.displayed.utf16.count / 40 + (store.streaming ? 1 : 0)) {
            if store.loading, msgs.isEmpty {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("正在加载对话…").caption()
                }
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 24)
            } else if let le = store.loadError, msgs.isEmpty {
                VStack(spacing: 8) {
                    Text(le).font(.owBodyS).foregroundStyle(OW.danger).multilineTextAlignment(.center)
                    Button("重新加载") { Haptics.tap(); loadAttempt += 1 }.font(.owLabel)
                }
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 24)
            } else if store.loaded, msgs.isEmpty, !store.streaming {
                greeting
            }
            ForEach(Array(msgs.enumerated()), id: \.offset) { i, m in
                ChatMessageRow(msg: m, chatId: store.chatId, client: client,
                               localImages: i == msgs.count - 1 ? store.optimisticImages : [])
            }
            if store.streaming {
                // 还在输出的这条同样长按可复制——复制已经吐出来的部分，不必等它写完
                StreamingMarkdown(text: store.stream.displayed, toolLine: store.toolLine, showCursor: true)
                    .padding(.horizontal, 16).padding(.vertical, 8)
                    .copyOnLongPress(store.stream.displayed)
                    .transition(.opacity)
            }
            Spacer(minLength: 8)
        }
        .background(OW.bg)
        .safeAreaBar(edge: .top) { ErrorBanner(message: store.error) }
        .safeAreaBar(edge: .bottom) {
            ComposerBar(
                text: $input, pendingImages: $pendingImages, pickerItems: $pickerItems,
                canSend: !store.streaming && store.canCompose, busy: store.streaming,
                controlHint: store.loading ? "正在连接对话服务…" : store.loadError,
                controlAction: store.loadError == nil ? nil : ("重试", { Haptics.tap(); loadAttempt += 1 }),
                placeholder: store.loading ? "正在加载模型…" : (store.loadError != nil ? "对话暂不可用" : "发消息…"),
                onSend: { Task { await send() } },
                focused: $focused
            )
        }
        .toolbar(.hidden, for: .tabBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .principal) { titleView } }
        .task(id: loadAttempt) {
            await store.load()
            if store.isNew, store.canCompose { focused = true }
            #if DEBUG
            // 调试：-ownward.debugPrompt "你好" [-ownward.debugProvider claude] 启动即发一条，用来实测流式
            if store.isNew, let p = UserDefaults.standard.string(forKey: "ownward.debugPrompt"), !p.isEmpty {
                if let prov = UserDefaults.standard.string(forKey: "ownward.debugProvider"), store.providers[prov] != nil {
                    store.provider = prov; store.model = store.providers[prov]?.first ?? "default"
                }
                input = p
                await send()
            }
            #endif
        }
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            Task {
                let (imgs, failed) = await PendingImage.load(items)
                pendingImages = Array((pendingImages + imgs).prefix(ImageEncoder.maxImages))
                if failed > 0 { store.error = "部分图片读取失败或超过 5MB" }
                pickerItems = []
            }
        }
        .animation(.snappy, value: store.streaming)
    }

    private var greeting: some View {
        Text("有什么可以帮你？")
            .font(.owHeadline).foregroundStyle(OW.text.opacity(0.85))
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, 160).padding(.bottom, 40)
            .transition(.opacity)
    }

    @ViewBuilder
    private var titleView: some View {
        if store.isNew {
            // 供应商键来自服务端配置（可含 codex-alt 第二账号等），逐键平铺
            Menu {
                ForEach(store.providers.keys.sorted(), id: \.self) { prov in
                    ForEach(store.providers[prov] ?? [], id: \.self) { m in
                        Button { Haptics.selection(); store.provider = prov; store.model = m } label: {
                            if prov == store.provider, m == store.model { Label("\(prov) · \(m)", systemImage: "checkmark") }
                            else { Text("\(prov) · \(m)") }
                        }
                    }
                }
            } label: {
                HStack(spacing: 3) {
                    Text("\(store.provider) · \(store.model)").font(.owTitleS).foregroundStyle(OW.text).lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(OW.textDim)
                }
            }
        } else {
            Text(store.title.isEmpty ? "新对话" : store.title).font(.owTitleS).lineLimit(1)
        }
    }

    private func send() async {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let images = pendingImages
        guard !text.isEmpty || !images.isEmpty, !store.streaming, store.canCompose else { return }
        input = ""; pendingImages = []
        if let (draft, imgs) = await store.send(text: text, images: images) {
            input = draft; pendingImages = imgs
        }
    }
}

private struct ChatMessageRow: View {
    let msg: AiMessage
    let chatId: String?
    let client: OwnwardClient
    let localImages: [UIImage]

    var body: some View {
        if msg.role == "user" {
            VStack(alignment: .trailing, spacing: 6) {
                if !localImages.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(Array(localImages.enumerated()), id: \.offset) { _, img in
                            Image(uiImage: img).resizable().scaledToFill()
                                .frame(width: 96, height: 96).clipShape(RoundedRectangle(cornerRadius: OWRadius.m))
                        }
                    }
                } else if !msg.images.isEmpty, let chatId {
                    HStack(spacing: 6) {
                        ForEach(msg.images) { img in
                            AuthedImage(url: client.chatImageURL(chatId: chatId, imageId: img.id), client: client)
                                .frame(width: 96, height: 96).clipShape(RoundedRectangle(cornerRadius: OWRadius.m))
                        }
                    }
                }
                // 每条消息都长按可复制（context menu 里的「复制」）
                if !msg.text.isEmpty { UserBubble(text: msg.text).copyOnLongPress(msg.text) }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.leading, 56).padding(.trailing, 16).padding(.vertical, 8)
        } else {
            MarkdownText(text: msg.text).padding(.horizontal, 16).padding(.vertical, 8)
                .copyOnLongPress(msg.text)
        }
    }
}
