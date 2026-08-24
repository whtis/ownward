package ai.ownward.app

import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.filled.Inbox
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import dev.chrisbanes.haze.HazeState
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import ai.ownward.app.data.ServerConfig
import ai.ownward.app.ui.AgentScreen
import ai.ownward.app.ui.AppDrawer
import ai.ownward.app.ui.ChatDetailScreen
import ai.ownward.app.ui.ChatListScreen
import ai.ownward.app.ui.DispatchScreen
import ai.ownward.app.ui.DrawerController
import ai.ownward.app.ui.DrawerDest
import ai.ownward.app.ui.InboxScreen
import ai.ownward.app.ui.LocalBottomBarPadding
import ai.ownward.app.ui.LocalDrawer
import ai.ownward.app.ui.LocalHazeState
import ai.ownward.app.ui.ObserveScreen
import ai.ownward.app.ui.SettingsScreen
import ai.ownward.app.ui.SetupScreen
import ai.ownward.app.ui.TaskDetailScreen
import ai.ownward.app.ui.glassBar
import ai.ownward.app.ui.theme.OwnwardTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            OwnwardTheme {
                Root()
            }
        }
    }
}

@Composable
private fun Root() {
    val app = LocalContext.current.applicationContext as App
    val config by app.settings.config.collectAsState(initial = null)
    when {
        config == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }

        !config!!.configured -> SetupScreen(app.settings)

        else -> MainShell(app, config!!)
    }
}

private data class Tab(val route: String, val label: String, val icon: @Composable () -> Unit)

@Composable
private fun MainShell(app: App, config: ServerConfig) {
    val nav: NavHostController = rememberNavController()
    val client = app.client(config)
    val tabs = listOf(
        Tab("inbox", "收件箱") { Icon(Icons.Filled.Inbox, null) },
        Tab("agent", "Agent") { Icon(Icons.Filled.SmartToy, null) },
        Tab("chat", "对话") { Icon(Icons.AutoMirrored.Filled.Chat, null) },
    )
    // 冷启动直达新对话（back 回列表）：打开 app 即可输入，无需先过列表
    LaunchedEffect(Unit) { nav.navigate("chatDetail") }
    val backStack by nav.currentBackStackEntryAsState()
    val currentRoute = backStack?.destination?.route
    val showBottomBar = currentRoute in tabs.map { it.route }
    val hazeState = remember { HazeState() }
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val drawer = remember(drawerState, scope) { DrawerController(drawerState, scope) }

    // 抽屉开着时返回键先关抽屉。M3 的 ModalNavigationDrawer 自己不拦返回，而 NavHost 注册的返回回调
    // 优先级压过这里的 BackHandler（实测：抽屉还开着，底下的页面已经被弹掉），所以开抽屉时直接把
    // NavHost 的回调关掉，关上再恢复——不依赖回调注册顺序
    val drawerOpen = drawerState.targetValue == DrawerValue.Open

    // 侧边栏高亮用的「当前页键」，与 DrawerDest.key() 同一套字符串。
    // 注意 chatDetail 的 id 取自路由参数：新对话发出第一条后拿到的 id 只在页面内部，这里仍算 chat:new
    val currentKey = when (currentRoute) {
        "inbox" -> "inbox"
        "dispatch" -> "dispatch"
        "settings" -> "settings"
        "task/{id}" -> backStack?.arguments?.getString("id")?.let { "task:$it" }
        "chatDetail?id={id}" -> backStack?.arguments?.getString("id")?.let { "chat:$it" } ?: "chat:new"
        "observe?id={id}&task={task}" ->
            backStack?.arguments?.getString("task")?.let { "terminal:$it" }
                ?: backStack?.arguments?.getString("id")?.let { "observe:$it" }

        else -> null
    }

    fun go(dest: DrawerDest) {
        drawer.close()
        if (dest.key() == currentKey) return // 点的就是当前页：只关抽屉，不重载
        val route = when (dest) {
            DrawerDest.Inbox -> "inbox"
            DrawerDest.NewChat -> "chatDetail"
            DrawerDest.NewTask -> "dispatch"
            DrawerDest.Settings -> "settings"
            is DrawerDest.Task -> "task/${dest.id}"
            is DrawerDest.Chat -> "chatDetail?id=${dest.id}"
            // 会话 id 含 "/" 和 ":"（"<hashDir>/<uuid>"、"cdx:home:id"），进路由必须编码
            is DrawerDest.Terminal ->
                "observe?task=${dest.taskId}" + (dest.ccId?.let { "&id=${Uri.encode(it)}" } ?: "")
        }
        // 抽屉切页不叠栈：先弹回首页再进新页，返回键永远一步回到对话列表，
        // 否则在侧边栏里连点十个会话就攒出十层返回栈
        nav.navigate(route) {
            popUpTo("chat") { saveState = true }
            launchSingleTop = true
        }
    }

    // edge-to-edge：内容画到 bar 背后（各页自己用 contentPadding 让位），bar 层毛玻璃透出内容
    CompositionLocalProvider(LocalHazeState provides hazeState, LocalDrawer provides drawer) {
        ModalNavigationDrawer(
            drawerState = drawerState,
            drawerContent = {
                AppDrawer(
                    client = client,
                    // targetValue：一开始拖就刷新列表，不等开合动画结束
                    isOpen = drawerState.targetValue == DrawerValue.Open,
                    selectedKey = currentKey,
                    onGo = { go(it) },
                )
            },
        ) {
            Scaffold(
                containerColor = MaterialTheme.colorScheme.background,
                contentWindowInsets = WindowInsets(0, 0, 0, 0),
                bottomBar = {
                    if (showBottomBar) NavigationBar(
                        containerColor = Color.Transparent,
                        modifier = Modifier.glassBar(),
                    ) {
                        tabs.forEach { tab ->
                            NavigationBarItem(
                                selected = currentRoute == tab.route,
                                onClick = {
                                    if (currentRoute != tab.route) nav.navigate(tab.route) {
                                        popUpTo("inbox") { saveState = true }
                                        launchSingleTop = true
                                        restoreState = true
                                    }
                                },
                                icon = tab.icon,
                                label = { Text(tab.label) },
                                colors = NavigationBarItemDefaults.colors(
                                    selectedIconColor = MaterialTheme.colorScheme.primary,
                                    selectedTextColor = MaterialTheme.colorScheme.primary,
                                    indicatorColor = MaterialTheme.colorScheme.surfaceVariant,
                                ),
                            )
                        }
                    }
                },
            ) { padding ->
                CompositionLocalProvider(LocalBottomBarPadding provides padding.calculateBottomPadding()) {
                    NavHost(
                        navController = nav,
                        startDestination = "chat",  // 首页=对话：打开就能聊（收件箱/Agent 在底栏一步可达）
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        composable("inbox") {
                            InboxScreen(
                                client = client,
                                onOpenTask = { nav.navigate("task/$it") },
                                onOpenChat = { nav.navigate("chatDetail?id=$it") },
                                onOpenSettings = { nav.navigate("settings") },
                            )
                        }
                        composable("agent") {
                            AgentScreen(
                                client = client,
                                onOpenTask = { nav.navigate("task/$it") },
                                onNewTask = { nav.navigate("dispatch") },
                                onOpenTerminal = { taskId, ccId ->
                                    nav.navigate("observe?task=$taskId" + (ccId?.let { "&id=${Uri.encode(it)}" } ?: ""))
                                },
                            )
                        }
                        composable("observe?id={id}&task={task}") { entry ->
                            ObserveScreen(
                                client = client,
                                ccId = entry.arguments?.getString("id"),
                                taskId = entry.arguments?.getString("task"),
                                onBack = { nav.popBackStack() },
                                // 接管成功直接进新会话续聊（旁观页出栈，back 回 Agent 列表）
                                onAdopted = { id ->
                                    nav.navigate("task/$id") { popUpTo("observe?id={id}&task={task}") { inclusive = true } }
                                },
                            )
                        }
                        composable("dispatch") {
                            DispatchScreen(
                                client = client,
                                onBack = { nav.popBackStack() },
                                // 派完直接进会话（表单页出栈，back 回 Agent 列表）
                                onDispatched = { id ->
                                    nav.navigate("task/$id") { popUpTo("dispatch") { inclusive = true } }
                                },
                            )
                        }
                        composable("chat") {
                            ChatListScreen(
                                client = client,
                                onOpenChat = { nav.navigate("chatDetail?id=$it") },
                                onNewChat = { nav.navigate("chatDetail") },
                            )
                        }
                        composable("task/{id}") { entry ->
                            TaskDetailScreen(
                                client = client,
                                taskId = entry.arguments?.getString("id") ?: "",
                                onBack = { nav.popBackStack() },
                            )
                        }
                        composable("chatDetail?id={id}") { entry ->
                            ChatDetailScreen(
                                client = client,
                                chatId = entry.arguments?.getString("id"),
                                onBack = { nav.popBackStack() },
                            )
                        }
                        composable("settings") {
                            SettingsScreen(app = app, config = config, onBack = { nav.popBackStack() })
                        }
                    }
                    // 抽屉开着时返回键先关抽屉。必须写在 NavHost 之后：返回回调按注册顺序倒着取，
                    // NavHost 自己也注册了一个（且每次重组都重新 enable），写在它前面会被它抢走——
                    // 实测症状是抽屉还开着，底下的页面已经被弹掉，在首页就是直接退出 app
                    BackHandler(enabled = drawerOpen) { drawer.close() }
                }
            }
        }
    }
}
