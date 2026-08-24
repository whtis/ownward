// 一体化 composer（ChatGPT 式玻璃 pill：附件/输入/主动作一个容器，主动作原位 morph）。
// busy：不可中断的忙碌（chat 流式/发送落盘中）→ 主动作转圈
// running + onInterrupt：任务运行中且无草稿 → 主动作为 Stop；一旦输入内容切回 Send（排队发送）
import SwiftUI
import PhotosUI

struct PendingImage: Identifiable, Equatable {
    let id = UUID()
    let thumbnail: UIImage
    let payload: OutImage
    static func == (a: PendingImage, b: PendingImage) -> Bool { a.id == b.id }
}

struct ComposerBar: View {
    @Binding var text: String
    @Binding var pendingImages: [PendingImage]
    @Binding var pickerItems: [PhotosPickerItem]
    var canSend: Bool
    var busy: Bool
    var running = false
    /// agent 忙时已发出、等本轮结束的消息
    var queued: [QueuedView] = []
    /// 撤回其中一条（服务端按 id 撤，撤不到会报错）
    var onCancelQueued: ((QueuedView) -> Void)? = nil
    var controlHint: String? = nil
    /// 提示旁的动作（如「接管输入」）：label + onTap
    var controlAction: (label: String, action: () -> Void)? = nil
    /// 斜杠命令补全表；nil = 这个输入框不开补全（非 claude 引擎 / AI 对话）
    var commands: [String]? = nil
    var placeholder = "发消息…"
    var onSend: () -> Void
    var onInterrupt: (() -> Void)? = nil
    @FocusState.Binding var focused: Bool

    private enum Mode { case busy, stop, send }

    private var hasDraft: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingImages.isEmpty
    }
    private var sendEnabled: Bool { canSend && hasDraft }
    private var mode: Mode {
        if busy { return .busy }
        if running, onInterrupt != nil, !sendEnabled { return .stop }
        return .send
    }

    /// 命中的斜杠命令；只在「整条输入就是一个 / 开头的词」时非空（规则见 Slash.swift）
    private var slashItems: [SlashCmd] {
        canSend ? Slash.matches(input: text, commands: commands) : []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let controlHint {
                HStack {
                    Text(controlHint).font(.owLabelM).foregroundStyle(OW.warn)
                    Spacer(minLength: 8)
                    if let controlAction {
                        Button(controlAction.label) { Haptics.action(); controlAction.action() }
                            .font(.owLabel)
                    }
                }
                .padding(.leading, 12).padding(.trailing, 4)
            }
            QueuedStrip(queued: queued, onCancel: onCancelQueued)
            if !slashItems.isEmpty { slashMenu(slashItems) }
            if !pendingImages.isEmpty { thumbs }
            HStack(alignment: .bottom, spacing: 4) {
                PhotosPicker(selection: $pickerItems, maxSelectionCount: ImageEncoder.maxImages, matching: .images) {
                    Image(systemName: "plus")
                        .font(.system(size: 19, weight: .medium))
                        .foregroundStyle(canSend ? OW.textDim : OW.outline)
                        .frame(width: 40, height: 40)
                        .contentShape(Circle())
                }
                .disabled(!canSend)
                .accessibilityLabel("添加图片")

                TextField(canSend ? placeholder : "无法输入", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .font(.owBody)
                    .tint(OW.accent)
                    .focused($focused)
                    .disabled(!canSend)
                    .padding(.vertical, 9)
                    .padding(.horizontal, 4)
                    .submitLabel(.return)

                actionButton
            }
            .padding(6)
            .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    /// 斜杠命令补全：浮在输入框正上方（键盘挡不到），点一条就把整条输入换成 "/name " 并保持焦点，
    /// 光标落在末尾直接写参数。超过一屏就滚，最多 40 条（Slash.matches 截断）。
    private func slashMenu(_ items: [SlashCmd]) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(items) { cmd in
                    Button {
                        Haptics.selection()
                        text = Slash.accept(cmd)
                        focused = true
                    } label: {
                        HStack(spacing: 10) {
                            Text("/\(cmd.name)").font(.owMono).foregroundStyle(OW.text)
                            if !cmd.desc.isEmpty {
                                Text(cmd.desc).font(.owBodyS).foregroundStyle(OW.textDim).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(maxHeight: 200)
        .scrollBounceBehavior(.basedOnSize)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: OWRadius.l, style: .continuous))
        .transition(.opacity.combined(with: .move(edge: .bottom)))
        .animation(.snappy(duration: 0.18), value: items)
    }

    private var thumbs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(pendingImages) { img in
                    Image(uiImage: img.thumbnail)
                        .resizable().scaledToFill()
                        .frame(width: 64, height: 64)
                        .clipShape(RoundedRectangle(cornerRadius: OWRadius.m))
                        .overlay(alignment: .topTrailing) {
                            Button {
                                Haptics.selection()
                                withAnimation(.snappy) { pendingImages.removeAll { $0.id == img.id } }
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 18))
                                    .symbolRenderingMode(.palette)
                                    .foregroundStyle(.white, .black.opacity(0.6))
                            }
                            .buttonStyle(.plain)
                            .offset(x: 5, y: -5)
                            .accessibilityLabel("移除图片")
                        }
                }
            }
            .padding(.leading, 8).padding(.top, 6)
        }
    }

    private var circleColor: Color {
        switch mode {
        case .busy: OW.surface3
        case .stop: OW.danger
        case .send: sendEnabled ? OW.text : OW.surface3
        }
    }

    private var actionButton: some View {
        Button {
            switch mode {
            case .busy: break
            case .stop: Haptics.action(); onInterrupt?()
            case .send: Haptics.action(); onSend()
            }
        } label: {
            ZStack {
                Circle().fill(circleColor)
                switch mode {
                case .busy:
                    ProgressView().controlSize(.small).tint(OW.textDim)
                case .stop:
                    Image(systemName: "stop.fill").font(.system(size: 15, weight: .bold)).foregroundStyle(OW.bg)
                case .send:
                    Image(systemName: "arrow.up").font(.system(size: 18, weight: .bold))
                        .foregroundStyle(sendEnabled ? OW.bg : OW.textDim)
                }
            }
            .frame(width: 40, height: 40)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .keyboardShortcut(.return, modifiers: .command)   // 外接键盘 ⌘↩ 发送（ChatGPT 同款）
        .disabled(mode == .send && !sendEnabled)
        .animation(.snappy(duration: 0.22), value: mode)
        .animation(.snappy(duration: 0.22), value: sendEnabled)
        .accessibilityLabel(mode == .stop ? "中断" : "发送")
    }
}
