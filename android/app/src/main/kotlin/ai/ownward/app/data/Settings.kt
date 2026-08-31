package ai.ownward.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable

private val Context.dataStore by preferencesDataStore(name = "ownward-settings")

@Serializable
data class ServerConfig(val baseUrl: String = "", val token: String = "") {
    val configured: Boolean get() = baseUrl.isNotBlank()  // token 可空：本地直连/免鉴权部署
}

internal const val DEFAULT_TOP_LEVEL_ROOT = "chat"

internal fun normalizeTopLevelRoot(root: String?): String = when (root) {
    "inbox", "agent", "chat" -> root
    else -> DEFAULT_TOP_LEVEL_ROOT
}

/**
 * token 用 Android Keystore（AES-GCM）加密后再落 DataStore——远程 daemon 的 token 是敏感凭据，
 * 明文存在 /data/data 里，root 设备或未加密备份就能读走（iOS 端存 Keychain，这里对齐其安全性）。
 * 密钥不出 Keystore、绑定本机。旧明文（无 enc: 前缀）读时原样返回，下次 save 自动加密——透明迁移。
 * Keystore 不可用时加密退回明文（不把 token 写丢）；解密失败（换机/密钥丢失）当作未配置，让用户重填。
 */
private object TokenCrypto {
    private const val KEY_ALIAS = "ownward-token-key"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val PREFIX = "enc:v1:"
    private const val IV_LEN = 12
    private const val TAG_BITS = 128

    private fun secretKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return gen.generateKey()
    }

    fun encrypt(plain: String): String {
        if (plain.isEmpty()) return ""
        return try {
            val cipher = Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, secretKey()) }
            val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
            PREFIX + Base64.encodeToString(cipher.iv + ct, Base64.NO_WRAP)
        } catch (e: Exception) {
            plain  // Keystore 不可用：退回明文，别把 token 写丢
        }
    }

    fun decrypt(stored: String): String {
        if (stored.isEmpty()) return ""
        if (!stored.startsWith(PREFIX)) return stored  // 旧明文（迁移前）原样读
        return try {
            val raw = Base64.decode(stored.removePrefix(PREFIX), Base64.NO_WRAP)
            val iv = raw.copyOfRange(0, IV_LEN)
            val ct = raw.copyOfRange(IV_LEN, raw.size)
            val cipher = Cipher.getInstance(TRANSFORM).apply {
                init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, iv))
            }
            String(cipher.doFinal(ct), Charsets.UTF_8)
        } catch (e: Exception) {
            ""  // 解密失败（换机/密钥丢失）：当未配置处理
        }
    }
}

class Settings(private val context: Context) {
    private val keyBaseUrl = stringPreferencesKey("base_url")
    private val keyToken = stringPreferencesKey("token")
    private val keyTopLevelRoot = stringPreferencesKey("top_level_root")

    val config: Flow<ServerConfig> = context.dataStore.data.map { p ->
        ServerConfig(
            baseUrl = p[keyBaseUrl] ?: "",
            token = TokenCrypto.decrypt(p[keyToken] ?: ""),
        )
    }

    val topLevelRoot: Flow<String> = context.dataStore.data
        .map { p -> normalizeTopLevelRoot(p[keyTopLevelRoot]) }
        .distinctUntilChanged()

    suspend fun save(baseUrl: String, token: String) {
        context.dataStore.edit { p ->
            p[keyBaseUrl] = baseUrl.trim().trimEnd('/')
            p[keyToken] = TokenCrypto.encrypt(token.trim())
        }
    }

    suspend fun saveTopLevelRoot(root: String) {
        val normalized = normalizeTopLevelRoot(root)
        context.dataStore.edit { p ->
            if (p[keyTopLevelRoot] != normalized) p[keyTopLevelRoot] = normalized
        }
    }
}
