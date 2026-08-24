package ai.ownward.app.ui

import androidx.compose.foundation.background
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.haze
import dev.chrisbanes.haze.hazeChild
import dev.chrisbanes.haze.materials.ExperimentalHazeMaterialsApi
import dev.chrisbanes.haze.materials.HazeMaterials
import ai.ownward.app.ui.theme.ownwardColors

// 毛玻璃基建：Haze 的所有调用都收在这个文件，升级 Haze（1.4+ 改名 hazeSource/hazeEffect）只动这里。
// Android 12+ 真实 backdrop blur；更旧系统 Haze 自动退化半透明蒙层。

/** MainShell 提供的共享取样状态；shell 外（Setup 页）为 null */
val LocalHazeState = compositionLocalOf<HazeState?> { null }

/** 外层玻璃导航栏实测高度（含手势区 inset），tab 页列表当 contentPadding 底部用 */
val LocalBottomBarPadding = compositionLocalOf<Dp> { 0.dp }

/** 滚动内容层：登记为毛玻璃取样源。背景色画进源图层，玻璃才有底可透 */
@Composable
fun Modifier.hazeContent(): Modifier {
    val state = LocalHazeState.current ?: return this.background(ownwardColors.Bg)
    return this.haze(state).background(ownwardColors.Bg)
}

/** bar 层毛玻璃（顶栏/底部导航/composer 容器）；无取样源时退化纯色 */
@OptIn(ExperimentalHazeMaterialsApi::class)
@Composable
fun Modifier.glassBar(): Modifier {
    val state = LocalHazeState.current ?: return this.background(ownwardColors.Bg)
    return this.hazeChild(state, style = HazeMaterials.regular(ownwardColors.Bg))
}
