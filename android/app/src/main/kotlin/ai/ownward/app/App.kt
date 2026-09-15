package ai.ownward.app

import android.app.Application
import ai.ownward.app.data.OwnwardClient
import ai.ownward.app.data.ServerConfig
import ai.ownward.app.data.Settings
import kotlinx.coroutines.flow.MutableStateFlow

class App : Application() {
    val settings by lazy { Settings(this) }
    /** 设置页发现新版本但用户按了「以后再说」：侧栏设置按钮亮红点，直到装上新版或再查确认已是最新 */
    val updateAvailable = MutableStateFlow(false)

    // 配置变了就重建，client 本身无状态
    @Volatile private var cached: Pair<ServerConfig, OwnwardClient>? = null

    fun client(config: ServerConfig): OwnwardClient {
        cached?.let { (c, client) -> if (c == config) return client }
        val client = OwnwardClient(config.baseUrl, config.token)
        cached = config to client
        return client
    }
}
