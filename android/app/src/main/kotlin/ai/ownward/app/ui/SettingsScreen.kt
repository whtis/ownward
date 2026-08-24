package ai.ownward.app.ui

import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import ai.ownward.app.App
import ai.ownward.app.BuildConfig
import ai.ownward.app.data.AppRelease
import ai.ownward.app.data.OwnwardClient
import ai.ownward.app.data.ServerConfig
import ai.ownward.app.ui.theme.ownwardColors
import kotlinx.coroutines.launch
import java.io.File
import java.util.Calendar

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(app: App, config: ServerConfig, onBack: () -> Unit) {
    var url by remember { mutableStateOf(config.baseUrl) }
    var token by remember { mutableStateOf(config.token) }
    var saving by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    var checking by remember { mutableStateOf(false) }
    var release by remember { mutableStateOf<AppRelease?>(null) }
    var downloading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text("设置", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
        ) {
            SectionHeader("服务器")
            OutlinedTextField(
                value = url, onValueChange = { url = it },
                label = { Text("服务地址") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = token, onValueChange = { token = it },
                label = { Text("API Token") }, singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            if (msg != null) {
                Text(msg!!, style = MaterialTheme.typography.bodySmall,
                    color = if (msg!!.contains("失败")) ownwardColors.Danger else ownwardColors.Success)
                Spacer(Modifier.height(8.dp))
            }
            Button(
                onClick = {
                    saving = true; msg = null
                    scope.launch {
                        try {
                            OwnwardClient(url.trim().trimEnd('/'), token.trim()).state()
                            app.settings.save(url, token)
                            msg = "已保存"
                        } catch (e: Exception) {
                            msg = "连接失败：${e.message}"
                        } finally {
                            saving = false
                        }
                    }
                },
                enabled = !saving,
            ) { Text("测试并保存") }

            Spacer(Modifier.height(24.dp))
            SectionHeader("关于")
            Surface(
                shape = MaterialTheme.shapes.medium,
                color = MaterialTheme.colorScheme.surface,
                modifier = Modifier.fillMaxWidth().clickable(enabled = !checking) {
                    checking = true; msg = null
                    scope.launch {
                        try {
                            val r = app.client(config).appRelease()
                            if (r.versionCode > BuildConfig.VERSION_CODE) release = r
                            else msg = "当前已是最新版本"
                        } catch (e: Exception) {
                            msg = "检查失败：${e.message}"
                        } finally {
                            checking = false
                        }
                    }
                },
            ) {
                Column(Modifier.padding(14.dp)) {
                    Text("检查更新", style = MaterialTheme.typography.bodyMedium)
                    Text(
                        if (checking) "检查中…" else "当前 ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Spacer(Modifier.height(48.dp))
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    "Ownward v${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    "© ${Calendar.getInstance().get(Calendar.YEAR)} Ownward contributors · Apache-2.0",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                )
                Spacer(Modifier.height(16.dp))
            }
        }
    }

    release?.let { r ->
        AlertDialog(
            onDismissRequest = { if (!downloading) release = null },
            title = { Text("发现新版本") },
            text = {
                Column {
                    Text("${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}) → ${r.versionName} (${r.versionCode})")
                    if (r.notes.isNotBlank()) {
                        Spacer(Modifier.height(8.dp))
                        Text(r.notes, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (downloading) {
                        Spacer(Modifier.height(12.dp))
                        CircularProgressIndicator(Modifier.height(24.dp))
                    }
                }
            },
            confirmButton = {
                TextButton(
                    enabled = !downloading,
                    onClick = {
                        downloading = true
                        scope.launch {
                            try {
                                val apk = File(context.cacheDir, "ownward-update.apk")
                                app.client(config).downloadApk(apk)
                                val uri = FileProvider.getUriForFile(
                                    context, BuildConfig.APPLICATION_ID + ".fileprovider", apk
                                )
                                context.startActivity(Intent(Intent.ACTION_VIEW).apply {
                                    setDataAndType(uri, "application/vnd.android.package-archive")
                                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                                })
                                release = null
                            } catch (e: Exception) {
                                msg = "下载失败:${e.message}"
                                release = null
                            } finally {
                                downloading = false
                            }
                        }
                    },
                ) { Text("立即更新") }
            },
            dismissButton = {
                TextButton(enabled = !downloading, onClick = { release = null }) { Text("以后再说") }
            },
        )
    }
}
