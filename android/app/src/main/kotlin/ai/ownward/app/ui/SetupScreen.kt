package ai.ownward.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ai.ownward.app.data.OwnwardClient
import ai.ownward.app.data.Settings
import ai.ownward.app.ui.theme.ownwardColors
import kotlinx.coroutines.launch

/** 首次配置：服务地址 + api token（daemon 的 data/secrets/api-token.txt） */
@Composable
fun SetupScreen(settings: Settings) {
    var url by rememberSaveable { mutableStateOf("") }
    var token by rememberSaveable { mutableStateOf("") }
    var testing by rememberSaveable { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .imePadding()
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Ownward", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Bold)
        Text(
            "连接你的 ownward daemon",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text("服务地址") },
            placeholder = { Text("https://your-domain 或 http://192.168.x.x:4517") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("API Token") },
            supportingText = { Text("daemon 机器上 data/secrets/api-token.txt 的内容；本地/免鉴权部署可留空") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(20.dp))
        if (error != null) {
            Text(error!!, color = ownwardColors.Danger, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.height(8.dp))
        }
        Button(
            onClick = {
                testing = true; error = null
                scope.launch {
                    try {
                        OwnwardClient(url.trim().trimEnd('/'), token.trim()).state()
                        settings.save(url, token)
                    } catch (e: Exception) {
                        error = e.message ?: "连接失败"
                    } finally {
                        testing = false
                    }
                }
            },
            enabled = !testing && url.isNotBlank(),  // token 可留空：本地直连（adb reverse/局域网免鉴权）不需要
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (testing) CircularProgressIndicator(Modifier.height(18.dp)) else Text("连接")
        }
    }
}
