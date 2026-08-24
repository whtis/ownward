// 服务地址 + API token 的持久化（对齐 android data/Settings.kt）：地址进 UserDefaults，
// token 进 Keychain（手机丢了也不裸奔）。token 可空：本地直连/免鉴权部署不需要。
import Foundation
import Observation
import Security

enum Keychain {
    private static let service = "ai.ownward.app"

    static func read(_ account: String) -> String? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ account: String, _ value: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        guard !value.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}

struct ServerConfig: Hashable, Sendable {
    var baseURL: String = ""
    var token: String = ""
    var configured: Bool { !baseURL.isEmpty }
}

@MainActor @Observable
final class AppSettings {
    private static let urlKey = "ownward.baseURL"
    private static let tokenAccount = "api-token"

    private(set) var config: ServerConfig
    private var cachedClient: (ServerConfig, OwnwardClient)?

    init() {
        let url = UserDefaults.standard.string(forKey: Self.urlKey) ?? ""
        config = ServerConfig(baseURL: url, token: url.isEmpty ? "" : (Keychain.read(Self.tokenAccount) ?? ""))
    }

    func save(baseURL: String, token: String) {
        let url = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let tok = token.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.standard.set(url, forKey: Self.urlKey)
        Keychain.write(Self.tokenAccount, tok)
        config = ServerConfig(baseURL: url, token: tok)
    }

    /// 配置不变就复用同一个 client（无状态，但 URLSession 连接池值得共享）
    var client: OwnwardClient? {
        guard config.configured else { return nil }
        if let (c, client) = cachedClient, c == config { return client }
        guard let client = OwnwardClient(baseURL: config.baseURL, token: config.token) else { return nil }
        cachedClient = (config, client)
        return client
    }
}
