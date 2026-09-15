package ai.ownward.app.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
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

/** 公开仓库与项目主页：设置页「关于」里的两条外链（docs/app-guidelines.md 要求设置页必须能找到仓库）。 */
private const val REPO_URL = "https://github.com/whtis/ownward"
private const val HOMEPAGE_URL = "https://whtis.github.io/ownward/"

/**
 * 设置：服务器（地址 / token / 测试并保存）、关于（检查更新 / 源代码 / 项目主页）、页脚署名。
 * 版本号只在页脚出现一次；「检查更新」行的副标题说的是更新状态（有没有新版本），不再重复当前版本。
 * 更新检查的结果就近显示在「关于」卡片下面，不再混进服务器区的保存提示里。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(app: App, config: ServerConfig, onBack: () -> Unit) {
    var url by remember { mutableStateOf(config.baseUrl) }
    var token by remember { mutableStateOf(config.token) }
    var saving by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    var checking by remember { mutableStateOf(false) }
    var aboutMsg by remember { mutableStateOf<String?>(null) }
    var release by remember { mutableStateOf<AppRelease?>(null) }          // 正在弹窗展示的新版本
    var pending by remember { mutableStateOf<AppRelease?>(null) }          // 发现了但按了「以后再说」的新版本：行上留提示 + 侧栏红点
    var downloading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val open = { link: String -> context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }

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
            Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxWidth()) {
                Column {
                    AboutRow(
                        title = "检查更新",
                        subtitle = when {
                            checking -> "检查中…"
                            pending != null -> "可更新至 ${pending!!.versionName} (${pending!!.versionCode})"
                            else -> "检查当前安装的版本是否有更新"
                        },
                        enabled = !checking,
                        trailing = {
                            when {
                                checking -> CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                                pending != null -> Box(Modifier.size(8.dp).background(ownwardColors.Danger, CircleShape))
                            }
                        },
                    ) {
                        // 已经发现过新版本：直接再弹一次，不用重新联网
                        pending?.let { release = it; return@AboutRow }
                        checking = true; aboutMsg = null
                        scope.launch {
                            try {
                                val r = app.client(config).appRelease()
                                if (r.versionCode > BuildConfig.VERSION_CODE) release = r
                                else { aboutMsg = "当前已是最新版本"; pending = null; app.updateAvailable.value = false }
                            } catch (e: Exception) {
                                aboutMsg = "检查失败：${e.message}"
                            } finally {
                                checking = false
                            }
                        }
                    }
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    AboutRow("源代码", "github.com/whtis/ownward · Apache-2.0", trailing = { ExternalLinkIcon() }) { open(REPO_URL) }
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    AboutRow("项目主页", "whtis.github.io/ownward", trailing = { ExternalLinkIcon() }) { open(HOMEPAGE_URL) }
                }
            }
            if (aboutMsg != null) {
                Spacer(Modifier.height(8.dp))
                Text(aboutMsg!!, style = MaterialTheme.typography.bodySmall,
                    color = if (aboutMsg!!.contains("失败")) ownwardColors.Danger else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 4.dp))
            }

            // 页脚署名（docs/app-guidelines.md「署名」）：居中两行，版本号只在这里出现
            Spacer(Modifier.height(32.dp))
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    "Ownward v${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    "© ${Calendar.getInstance().get(Calendar.YEAR)} Tis Wu · Apache-2.0",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                )
                Spacer(Modifier.height(16.dp))
            }
        }
    }

    release?.let { r ->
        AlertDialog(
            onDismissRequest = { if (!downloading) { release = null; pending = r; app.updateAvailable.value = true } },
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
                                app.client(config).downloadApk(apk, r.downloadUrl.takeIf { it.isNotBlank() })
                                val uri = FileProvider.getUriForFile(
                                    context, BuildConfig.APPLICATION_ID + ".fileprovider", apk
                                )
                                context.startActivity(Intent(Intent.ACTION_VIEW).apply {
                                    setDataAndType(uri, "application/vnd.android.package-archive")
                                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                                })
                                release = null; pending = null; app.updateAvailable.value = false
                            } catch (e: Exception) {
                                aboutMsg = "下载失败：${e.message}"
                                release = null; pending = r; app.updateAvailable.value = true
                            } finally {
                                downloading = false
                            }
                        }
                    },
                ) { Text("立即更新") }
            },
            dismissButton = {
                // 「以后再说」：行上保留可更新提示，侧栏设置按钮亮红点，直到装上新版或再查确认已是最新
                TextButton(enabled = !downloading, onClick = { release = null; pending = r; app.updateAvailable.value = true }) { Text("以后再说") }
            },
        )
    }
}

/** 「关于」卡片里的一行：标题 + 副标题，右侧可放进度圈 / 红点 / 外链图标 */
@Composable
private fun AboutRow(title: String, subtitle: String, enabled: Boolean = true, trailing: @Composable () -> Unit = {}, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(enabled = enabled, onClick = onClick).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyMedium)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(12.dp))
        trailing()
    }
}

@Composable
private fun ExternalLinkIcon() {
    Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = "打开链接", modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
}
