package ai.ownward.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// ChatGPT 式近单色色板（codex UI 调研定稿）：低噪声、层级靠留白与字重，
// 蓝色只用于焦点/链接/状态；语义色固定，不随系统 Dynamic Color 漂移。
// 深浅两套值跟随系统深浅色切换，通过 ownwardColors 在组合内取当前套。
// 属性名保持大写开头是为了和旧 object OwnwardColors 的几十处调用点兼容。
@Immutable
data class OwnwardPalette(
    val Bg: Color,
    val Surface1: Color,
    val Surface2: Color,
    val Surface3: Color,
    val UserBubble: Color,
    val Text: Color,
    val TextDim: Color,
    val Outline: Color,
    val OutlineFaint: Color,
    val Accent: Color,
    val Success: Color,
    val Warn: Color,
    val Danger: Color,
)

private val DarkPalette = OwnwardPalette(
    Bg = Color(0xFF0D0D0E),
    Surface1 = Color(0xFF171719),
    Surface2 = Color(0xFF212124),
    Surface3 = Color(0xFF2A2A2E),
    UserBubble = Color(0xFF2B2B2F),
    Text = Color(0xFFF1F1F2),
    TextDim = Color(0xFFA1A1A8),
    Outline = Color(0xFF343438),
    OutlineFaint = Color(0xFF29292C),
    Accent = Color(0xFF63A8FF),
    Success = Color(0xFF56C991),
    Warn = Color(0xFFE4B85B),
    Danger = Color(0xFFF0717E),
)

// 浅色值都按白底 4.5:1 左右的对比度挑的，语义色比深色套整体压暗一档。
private val LightPalette = OwnwardPalette(
    Bg = Color(0xFFFFFFFF),
    Surface1 = Color(0xFFF6F6F7),
    Surface2 = Color(0xFFEFEFF1),
    Surface3 = Color(0xFFE7E7EA),
    UserBubble = Color(0xFFECECEE),
    Text = Color(0xFF1A1A1E),
    TextDim = Color(0xFF70707A),
    Outline = Color(0xFFD8D8DE),
    OutlineFaint = Color(0xFFE9E9EE),
    Accent = Color(0xFF2E6BD6),
    Success = Color(0xFF178A56),
    Warn = Color(0xFF9A7A16),
    Danger = Color(0xFFCC3D52),
)

val LocalOwnwardColors = staticCompositionLocalOf { DarkPalette }

/** 当前深浅色对应的色板，用法同旧 object：ownwardColors.Accent（仅组合内可取）。 */
val ownwardColors: OwnwardPalette
    @Composable @ReadOnlyComposable get() = LocalOwnwardColors.current

private val DarkScheme = darkColorScheme(
    primary = DarkPalette.Accent,
    onPrimary = Color(0xFF0A1930),
    secondary = DarkPalette.Success,
    onSecondary = Color(0xFF07201A),
    error = DarkPalette.Danger,
    onError = Color(0xFF2B0A10),
    background = DarkPalette.Bg,
    onBackground = DarkPalette.Text,
    surface = DarkPalette.Surface1,
    onSurface = DarkPalette.Text,
    surfaceVariant = DarkPalette.Surface2,
    onSurfaceVariant = DarkPalette.TextDim,
    surfaceContainerHighest = DarkPalette.Surface3,
    surfaceContainer = DarkPalette.Surface1,
    primaryContainer = Color(0xFF23405F), // FAB 等容器色，跟随强调蓝
    onPrimaryContainer = Color(0xFFCBE1FF),
    outline = DarkPalette.Outline,
    outlineVariant = DarkPalette.OutlineFaint,
)

private val LightScheme = lightColorScheme(
    primary = LightPalette.Accent,
    onPrimary = Color(0xFFFFFFFF),
    secondary = LightPalette.Success,
    onSecondary = Color(0xFFFFFFFF),
    error = LightPalette.Danger,
    onError = Color(0xFFFFFFFF),
    background = LightPalette.Bg,
    onBackground = LightPalette.Text,
    surface = LightPalette.Surface1,
    onSurface = LightPalette.Text,
    surfaceVariant = LightPalette.Surface2,
    onSurfaceVariant = LightPalette.TextDim,
    surfaceContainerHighest = LightPalette.Surface3,
    surfaceContainer = LightPalette.Surface1,
    primaryContainer = Color(0xFFD9E7FC),
    onPrimaryContainer = Color(0xFF143C74),
    outline = LightPalette.Outline,
    outlineVariant = LightPalette.OutlineFaint,
)

// 排版 token：消息正文 bodyLarge 16/24、列表正文 bodyMedium 15/21、辅助 bodySmall 13/18，
// 标题靠字重不靠加粗放大；空态问候 headlineMedium 28/34。
private val OwnwardType = Typography(
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 21.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
    labelLarge = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 15.sp, fontWeight = FontWeight.Medium),
    titleLarge = TextStyle(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
    titleSmall = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    headlineMedium = TextStyle(fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.Medium),
)

private val OwnwardShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(12.dp),
    large = RoundedCornerShape(16.dp),
    extraLarge = RoundedCornerShape(24.dp),
)

@Composable
fun OwnwardTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    CompositionLocalProvider(LocalOwnwardColors provides if (dark) DarkPalette else LightPalette) {
        MaterialTheme(
            colorScheme = if (dark) DarkScheme else LightScheme,
            shapes = OwnwardShapes,
            typography = OwnwardType,
            content = content,
        )
    }
}
