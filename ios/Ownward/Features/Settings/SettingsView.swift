// 设置：服务器地址/token（测试并保存）、关于（检查更新 / 源代码 / 项目主页）、页脚署名。
// 版本号只在页脚出现一次；「检查更新」行的副标题说的是更新状态，不重复当前版本；
// 检查结果就近显示在「关于」区，不混进服务器区的保存提示。
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

/// 公开仓库与项目主页：设置页「关于」里的两条外链（docs/app-guidelines.md 要求设置页必须能找到仓库）
private let repoURL = URL(string: "https://github.com/whtis/ownward")!
private let homepageURL = URL(string: "https://whtis.github.io/ownward/")!

struct SettingsView: View {
    @Environment(AppSettings.self) private var settings
    @Environment(\.openURL) private var openURL
    @State private var url = ""
    @State private var token = ""
    @State private var saving = false
    @State private var message: String?
    @State private var checking = false
    @State private var aboutMessage: String?
    @State private var release: AppRelease?      // 正在弹窗展示的新版本
    @State private var pending: AppRelease?      // 发现了但按了「以后再说」：行上留提示 + 设置入口红点
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
            Section {
                Button { Task { await checkUpdate() } } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("检查更新").listBody().foregroundStyle(OW.text)
                            Text(updateSubtitle).caption()
                        }
                        Spacer()
                        if checking { ProgressView().controlSize(.small) }
                        else if pending != nil { Circle().fill(OW.danger).frame(width: 8, height: 8) }
                    }
                }
                .disabled(checking)
                aboutLink("源代码", subtitle: "github.com/whtis/ownward · Apache-2.0", url: repoURL)
                aboutLink("项目主页", subtitle: "whtis.github.io/ownward", url: homepageURL)
            } header: {
                Text("关于")
            } footer: {
                if let aboutMessage {
                    Text(aboutMessage).font(.owBodyS)
                        .foregroundStyle(aboutMessage.contains("失败") ? OW.danger : OW.textDim)
                }
            }
            Section {
                // 页脚署名（docs/app-guidelines.md「署名」）：居中两行，版本号只在这里出现
                VStack(spacing: 4) {
                    // Text 插值会把 Int 按 locale 格式化成 202,608,211，build 号必须 String() 包裹
                    Text("Ownward v\(AppVersion.name) (\(String(AppVersion.build)))").font(.owBodyS).foregroundStyle(OW.textDim)
                    Text("© \(String(Calendar.current.component(.year, from: Date()))) Tis Wu · Apache-2.0")
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
        .alert("发现新版本", isPresented: Binding(get: { release != nil }, set: { if !$0 { dismissRelease() } })) {
            Button("以后再说", role: .cancel) { dismissRelease() }
            Button("立即更新") {
                if let s = release?.url, let u = URL(string: s) { openURL(u) }
                else { aboutMessage = "请通过 TestFlight / Xcode 安装新版本" }
                release = nil
            }
        } message: {
            if let r = release {
                Text("\(AppVersion.name) (\(String(AppVersion.build))) → \(r.versionName) (\(String(r.versionCode)))" + (r.notes.isEmpty ? "" : "\n\n\(r.notes)"))
            }
        }
    }

    private var updateSubtitle: String {
        if checking { return "检查中…" }
        if let p = pending { return "可更新至 \(p.versionName) (\(String(p.versionCode)))" }
        return "检查当前安装的版本是否有更新"
    }

    /// 「关于」里的外链行：标题 + 副标题 + 外链图标，点整行打开
    private func aboutLink(_ title: String, subtitle: String, url: URL) -> some View {
        Button { openURL(url) } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).listBody().foregroundStyle(OW.text)
                    Text(subtitle).caption()
                }
                Spacer()
                Image(systemName: "arrow.up.right.square").font(.owBodyS).foregroundStyle(OW.textDim)
            }
        }
    }

    /// 「以后再说」/ 划掉弹窗：行上保留可更新提示，设置入口亮红点，直到装上新版或再查确认已是最新
    private func dismissRelease() {
        if let r = release { pending = r; settings.updateAvailable = true }
        release = nil
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
        // 已经发现过新版本：直接再弹一次，不用重新联网
        if let p = pending { release = p; return }
        guard let client = settings.client else { aboutMessage = "请先配置服务器"; return }
        checking = true; aboutMessage = nil
        defer { checking = false }
        do {
            let r = try await client.appRelease()
            if r.versionCode > AppVersion.build { release = r; Haptics.success() }
            else { aboutMessage = "当前已是最新版本"; pending = nil; settings.updateAvailable = false }
        } catch {
            aboutMessage = "检查失败：\(error.userMessage)"
        }
    }
}
