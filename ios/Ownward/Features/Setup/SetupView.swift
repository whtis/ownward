// 首次配置：服务地址 + api token（daemon 的 data/secrets/api-token.txt）
import SwiftUI

struct SetupView: View {
    @Environment(AppSettings.self) private var settings
    @State private var url = ""
    @State private var token = ""
    @State private var testing = false
    @State private var error: String?
    @FocusState private var focus: Field?
    private enum Field { case url, token }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Spacer(minLength: 80)
                Text("Ownward").font(.system(size: 34, weight: .bold))
                Text("连接你的 ownward daemon").listBody().foregroundStyle(OW.textDim).padding(.top, 4)
                VStack(spacing: 12) {
                    field("服务地址", "https://your-domain 或 http://192.168.x.x:4517", text: $url, field: .url)
                        .keyboardType(.URL).textContentType(.URL)
                    field("API Token", "本地/免鉴权部署可留空", text: $token, field: .token)
                }
                .padding(.top, 24)
                Text("daemon 机器上 data/secrets/api-token.txt 的内容").caption().padding(.top, 6).padding(.leading, 4)
                if let error {
                    Text(error).font(.owBodyS).foregroundStyle(OW.danger).padding(.top, 12)
                        .transition(.opacity)
                }
                Button {
                    Task { await connect() }
                } label: {
                    Group {
                        if testing { ProgressView().tint(OW.bg) } else { Text("连接").font(.owTitleS) }
                    }
                    .frame(maxWidth: .infinity).frame(height: 50)
                }
                .buttonStyle(.glassProminent)
                .disabled(testing || url.trimmingCharacters(in: .whitespaces).isEmpty)
                .padding(.top, 20)
            }
            .padding(24)
        }
        .background(OW.bg)
        .scrollDismissesKeyboard(.interactively)
        .animation(.snappy, value: error)
    }

    private func field(_ label: String, _ placeholder: String, text: Binding<String>, field: Field) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.owLabel).foregroundStyle(OW.textDim)
            TextField(placeholder, text: text)
                .font(.owBody)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .focused($focus, equals: field)
                .padding(.horizontal, 14).frame(height: 46)
                .background(OW.surface1, in: RoundedRectangle(cornerRadius: OWRadius.m))
                .overlay(RoundedRectangle(cornerRadius: OWRadius.m).strokeBorder(focus == field ? OW.accent : OW.outlineFaint, lineWidth: 1))
        }
    }

    private func connect() async {
        testing = true; error = nil
        defer { testing = false }
        guard let client = OwnwardClient(baseURL: url, token: token) else {
            error = "地址格式不对（需要 http:// 或 https:// 开头）"; Haptics.error(); return
        }
        do {
            _ = try await client.state()
            Haptics.success()
            settings.save(baseURL: url, token: token)
        } catch {
            self.error = error.userMessage
            Haptics.error()
        }
    }
}
