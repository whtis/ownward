package ai.ownward.app.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable

private val Context.dataStore by preferencesDataStore(name = "ownward-settings")

@Serializable
data class ServerConfig(val baseUrl: String = "", val token: String = "") {
    val configured: Boolean get() = baseUrl.isNotBlank()  // token 可空：本地直连/免鉴权部署
}

class Settings(private val context: Context) {
    private val keyBaseUrl = stringPreferencesKey("base_url")
    private val keyToken = stringPreferencesKey("token")

    val config: Flow<ServerConfig> = context.dataStore.data.map { p ->
        ServerConfig(
            baseUrl = p[keyBaseUrl] ?: "",
            token = p[keyToken] ?: "",
        )
    }

    suspend fun save(baseUrl: String, token: String) {
        context.dataStore.edit { p ->
            p[keyBaseUrl] = baseUrl.trim().trimEnd('/')
            p[keyToken] = token.trim()
        }
    }
}
