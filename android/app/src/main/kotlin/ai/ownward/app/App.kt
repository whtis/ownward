package ai.ownward.app

import android.app.Application
import ai.ownward.app.data.OwnwardClient
import ai.ownward.app.data.ServerConfig
import ai.ownward.app.data.Settings

class App : Application() {
    val settings by lazy { Settings(this) }

    // 配置变了就重建，client 本身无状态
    @Volatile private var cached: Pair<ServerConfig, OwnwardClient>? = null

    fun client(config: ServerConfig): OwnwardClient {
        cached?.let { (c, client) -> if (c == config) return client }
        val client = OwnwardClient(config.baseUrl, config.token)
        cached = config to client
        return client
    }
}
