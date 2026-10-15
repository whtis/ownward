package ai.ownward.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ai.ownward.app.data.AgentRole
import ai.ownward.app.data.OwnwardClient
import ai.ownward.app.data.RoleSuggestion
import ai.ownward.app.ui.theme.ownwardColors
import kotlinx.coroutines.launch

/**
 * 角色（web 角色页的手机版，只做「找到角色 → 派任务给它」这一件事）。
 * 项目 Owner 是往仓库派任务时自动建的，跨项目角色由人点头才建（顶上的建议），领域角色管没有仓库的那类活；
 * 原则 / 决策 / 候选晋升这些长期记忆的维护还在 web 角色页——手机上不做人工审批门。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RolesScreen(client: OwnwardClient, onBack: () -> Unit, onDispatchRole: (String) -> Unit) {
    var roles by remember { mutableStateOf<List<AgentRole>>(emptyList()) }
    var suggestions by remember { mutableStateOf<List<RoleSuggestion>>(emptyList()) }
    var supported by remember { mutableStateOf(true) }
    var loaded by remember { mutableStateOf(false) }
    var busyKey by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        try {
            val r = client.roles()
            roles = r.roles
            supported = r.dispatchRole
            // 建议是锦上添花：拿不到不算错，列表照常用
            suggestions = if (r.dispatchRole) runCatching { client.roleSuggestions().suggestions }.getOrDefault(emptyList()) else emptyList()
            error = null
        } catch (e: Exception) {
            error = e.message
        }
        loaded = true
    }
    LaunchedEffect(Unit) { load() }

    fun accept(s: RoleSuggestion) {
        if (busyKey != null) return
        busyKey = s.key
        scope.launch {
            try {
                val r = client.createCrossRole(s.dirs)
                if (!r.ok) error = r.msg.ifBlank { "没建成" } else load()
            } catch (e: Exception) {
                error = e.message
            } finally {
                busyKey = null
            }
        }
    }

    fun dismiss(s: RoleSuggestion) {
        if (busyKey != null) return
        busyKey = s.key
        scope.launch {
            try {
                val r = client.dismissRoleSuggestion(s.key)
                if (!r.ok) error = r.msg.ifBlank { "忽略失败" } else suggestions = suggestions.filterNot { it.key == s.key }
            } catch (e: Exception) {
                error = e.message
            } finally {
                busyKey = null
            }
        }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            Column(Modifier.glassBar()) {
                TopAppBar(
                    title = { Text("角色", fontWeight = FontWeight.Bold) },
                    navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                )
                ErrorBanner(error)
            }
        },
    ) { padding ->
        val groups = groupRoles(roles)
        LazyColumn(
            Modifier.fillMaxSize().hazeContent(),
            contentPadding = PaddingValues(top = padding.calculateTopPadding() + 4.dp, bottom = padding.calculateBottomPadding() + 24.dp),
        ) {
            if (loaded && !supported) item {
                Hint("这台 daemon 还没有自动角色：升级 Ownward 后，这里会列出各项目的 Owner")
            }
            if (suggestions.isNotEmpty()) {
                item { SectionHeader("发现跨项目的工作") }
                items(suggestions, key = { "sg-" + it.key }) { s ->
                    Surface(
                        shape = MaterialTheme.shapes.medium,
                        color = MaterialTheme.colorScheme.primary.copy(alpha = 0.10f),
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    ) {
                        Column(Modifier.padding(12.dp)) {
                            Text(s.labels.joinToString(" + "), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Text(suggestionSub(s), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(onClick = { accept(s) }, enabled = busyKey == null) { Text("建「${s.name}」") }
                                TextButton(onClick = { dismiss(s) }, enabled = busyKey == null) { Text("忽略") }
                            }
                        }
                    }
                }
            }
            roleSection("项目 Owner", groups.owners, onDispatchRole)
            roleSection("领域角色", groups.domains, onDispatchRole)
            roleSection("跨项目角色", groups.cross, onDispatchRole)
            roleSection("人建的角色", groups.manual, onDispatchRole)
            if (loaded && roles.isEmpty() && error == null) item {
                Hint("还没有角色。往一个 git 仓库派任务，就会自动生成它的项目 Owner")
            }
            if (roles.isNotEmpty()) item {
                Hint("点角色 = 派任务给它（自动填好它的工作目录）。原则、决策等长期记忆在网页「角色」页维护")
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.roleSection(
    title: String, list: List<AgentRole>, onDispatchRole: (String) -> Unit,
) {
    if (list.isEmpty()) return
    item(key = "h-$title") { SectionHeader(title) }
    items(list, key = { "r-" + it.id }) { r ->
        // 冲突的角色服务端一概拒绝操作：照样列出来（藏掉等于让那份记忆凭空消失），但点不进去
        EntityRow(
            title = r.name.ifBlank { r.id },
            sub = if (r.conflict) "⚠️ " + r.conflictMsg.ifBlank { "这个角色有歧义，先在网页角色页处理" } else roleSub(r),
            dot = if (r.conflict) ownwardColors.Danger else null,
        ) { if (!r.conflict) onDispatchRole(r.id) }
    }
}

@Composable
private fun Hint(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 24.dp, vertical = 12.dp),
    )
}
