// 设置：服务器地址/token（测试并保存）、关于（检查更新）、页脚署名
import SwiftUI

enum AppVersion {
    static var name: String {
        (Bundle.main.object(forInfoDictionaryKey: "OwnwardVersionName") as? String)
            ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0"
    }
    static var build: Int {
        Int((Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) ?? "") ?? 0
    }
}

struct SettingsView: View {
    @Environment(AppSettings.self) private var settings
    @Environment(\.openURL) private var openURL
    @State private var url = ""
    @State private var token = ""
    @State private var saving = false
    @State private var message: String?
    @State private var checking = false
    @State private var release: AppRelease?
    @State private var didLoad = false

    var body: some View {
        List {
            Section("服务器") {
                TextField("服务地址", text: $url).font(.owBody)
                    .keyboardType(.URL).textContentType(.URL)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("API Token", text: $token).font(.owBody)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                if let message {
                    Text(message).font(.owBodyS)
                        .foregroundStyle(message.contains("失败") ? OW.danger : OW.success)
                }
                Button {
                    Task { await save() }
                } label: {
                    HStack { Text("测试并保存"); if saving { Spacer(); ProgressView().controlSize(.small) } }
                }
                .disabled(saving)
            }
            Section("关于") {
                Button { Task { await checkUpdate() } } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("检查更新").listBody().foregroundStyle(OW.text)
                        Text(checking ? "检查中…" : "当前 \(AppVersion.name) (\(String(AppVersion.build)))").caption()
                    }
                }
                .disabled(checking)
            }
            Section {
                VStack(spacing: 4) {
                    // Text 插值会把 Int 按 locale 格式化成 202,608,211，build 号必须 String() 包裹
                    Text("Ownward v\(AppVersion.name) (\(String(AppVersion.build)))").font(.owBodyS).foregroundStyle(OW.textDim)
                    Text("© \(String(Calendar.current.component(.year, from: Date()))) Ownward contributors · Apache-2.0")
                        .font(.owBodyS).foregroundStyle(OW.textDim.opacity(0.6))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .listRowBackground(Color.clear)
            }
        }
        .scrollContentBackground(.hidden)
        .background(OW.bg)
        .navigationTitle("设置")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard !didLoad else { return }
            didLoad = true
            url = settings.config.baseURL; token = settings.config.token
        }
        .alert("发现新版本", isPresented: Binding(get: { release != nil }, set: { if !$0 { release = nil } })) {
            Button("以后再说", role: .cancel) { release = nil }
            Button("立即更新") {
                if let s = release?.url, let u = URL(string: s) { openURL(u) }
                else { message = "请通过 TestFlight / Xcode 安装新版本" }
                release = nil
            }
        } message: {
            if let r = release {
                Text("\(AppVersion.name) (\(String(AppVersion.build))) → \(r.versionName) (\(String(r.versionCode)))" + (r.notes.isEmpty ? "" : "\n\n\(r.notes)"))
            }
        }
    }

    private func save() async {
        saving = true; message = nil
        defer { saving = false }
        guard let client = OwnwardClient(baseURL: url, token: token) else {
            message = "连接失败：地址格式不对"; Haptics.error(); return
        }
        do {
            _ = try await client.state()
            settings.save(baseURL: url, token: token)
            message = "已保存"; Haptics.success()
        } catch {
            message = "连接失败：\(error.userMessage)"; Haptics.error()
        }
    }

    private func checkUpdate() async {
        guard let client = settings.client else { return }
        checking = true; message = nil
        defer { checking = false }
        do {
            let r = try await client.appRelease()
            if r.versionCode > AppVersion.build { release = r; Haptics.success() }
            else { message = "当前已是最新版本" }
        } catch {
            message = "检查失败：\(error.userMessage)"
        }
    }
}
