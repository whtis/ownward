package ai.ownward.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.ownward.app.ui.theme.ownwardColors
import kotlinx.coroutines.delay

// 对齐 web/app.js mdHtml() 的语法子集 + 表格。流式渲染时未闭合的代码围栏一路吃到结尾（有意为之）。

private sealed class MdBlock {
    data class Heading(val level: Int, val text: String) : MdBlock()
    data class Paragraph(val text: String) : MdBlock()
    data class Code(val lang: String, val text: String) : MdBlock()
    data class Quote(val lines: List<String>) : MdBlock()
    data class ListBlock(val items: List<String>, val ordered: Boolean) : MdBlock()
    data class Table(val header: List<String>, val rows: List<List<String>>) : MdBlock()
    object Rule : MdBlock()
}

/** `| a | b |` → ["a","b"] */
private fun tableCells(line: String): List<String> =
    line.trim().removePrefix("|").removeSuffix("|").split("|").map { it.trim() }

/** 表格分隔行：`|---|:--:|` 之类 */
private fun isTableRule(line: String): Boolean {
    val t = line.trim()
    return t.startsWith("|") && t.contains("---") && t.all { it in "|-: \t" }
}

private fun parseBlocks(src: String): List<MdBlock> {
    val blocks = mutableListOf<MdBlock>()
    val lines = src.lines()
    var i = 0
    val para = StringBuilder()
    fun flushPara() {
        if (para.isNotBlank()) blocks.add(MdBlock.Paragraph(para.toString().trim()))
        para.clear()
    }
    while (i < lines.size) {
        val line = lines[i]
        when {
            line.trimStart().startsWith("```") -> {
                flushPara()
                val lang = line.trimStart().removePrefix("```").trim()
                val code = StringBuilder()
                i++
                while (i < lines.size && !lines[i].trimStart().startsWith("```")) {
                    code.appendLine(lines[i]); i++
                }
                blocks.add(MdBlock.Code(lang, code.toString().trimEnd('\n')))
            }

            line.trim().startsWith("|") && i + 1 < lines.size && isTableRule(lines[i + 1]) -> {
                flushPara()
                val header = tableCells(line)
                i += 2
                val rows = mutableListOf<List<String>>()
                while (i < lines.size && lines[i].trim().startsWith("|")) {
                    rows.add(tableCells(lines[i])); i++
                }
                blocks.add(MdBlock.Table(header, rows)); continue
            }

            line.matches(Regex("^#{1,4}\\s+.*")) -> {
                flushPara()
                val level = line.takeWhile { it == '#' }.length
                blocks.add(MdBlock.Heading(level, line.dropWhile { it == '#' }.trim()))
            }

            line.matches(Regex("^(---+|\\*\\*\\*+)\\s*$")) -> {
                flushPara(); blocks.add(MdBlock.Rule)
            }

            line.startsWith("> ") || line == ">" -> {
                flushPara()
                val quote = mutableListOf<String>()
                while (i < lines.size && (lines[i].startsWith("> ") || lines[i] == ">")) {
                    quote.add(lines[i].removePrefix(">").removePrefix(" ")); i++
                }
                blocks.add(MdBlock.Quote(quote)); continue
            }

            line.matches(Regex("^\\s*[-*]\\s+.*")) -> {
                flushPara()
                val items = mutableListOf<String>()
                while (i < lines.size && lines[i].matches(Regex("^\\s*[-*]\\s+.*"))) {
                    items.add(lines[i].replaceFirst(Regex("^\\s*[-*]\\s+"), "")); i++
                }
                blocks.add(MdBlock.ListBlock(items, ordered = false)); continue
            }

            line.matches(Regex("^\\s*\\d+[.)]\\s+.*")) -> {
                flushPara()
                val items = mutableListOf<String>()
                while (i < lines.size && lines[i].matches(Regex("^\\s*\\d+[.)]\\s+.*"))) {
                    items.add(lines[i].replaceFirst(Regex("^\\s*\\d+[.)]\\s+"), "")); i++
                }
                blocks.add(MdBlock.ListBlock(items, ordered = true)); continue
            }

            line.isBlank() -> flushPara()

            else -> {
                if (para.isNotEmpty()) para.append('\n')
                para.append(line)
            }
        }
        i++
    }
    flushPara()
    return blocks
}

/** 行内语法：**粗** *斜* `代码` [文字](https://链接) */
private fun inline(text: String, codeBg: androidx.compose.ui.graphics.Color, linkColor: androidx.compose.ui.graphics.Color): AnnotatedString =
    buildAnnotatedString {
        var rest = text
        val pattern = Regex("(\\*\\*(.+?)\\*\\*)|(\\*(.+?)\\*)|(`([^`]+)`)|(\\[([^\\]]+)]\\((https?://[^)\\s]+)\\))")
        while (true) {
            val m = pattern.find(rest) ?: break
            append(rest.substring(0, m.range.first))
            val g = m.groupValues
            when {
                g[2].isNotEmpty() -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(g[2]) }
                g[4].isNotEmpty() -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(g[4]) }
                g[6].isNotEmpty() -> withStyle(
                    SpanStyle(fontFamily = FontFamily.Monospace, background = codeBg, fontSize = 13.sp)
                ) { append(g[6]) }

                g[8].isNotEmpty() -> {
                    val link = LinkAnnotation.Url(
                        g[9],
                        TextLinkStyles(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline))
                    )
                    withLink(link) { append(g[8]) }
                }
            }
            rest = rest.substring(m.range.last + 1)
        }
        append(rest)
    }

@Composable
fun MarkdownText(text: String, modifier: Modifier = Modifier) {
    val blocks = remember(text) { parseBlocks(text) }
    val codeBg = ownwardColors.Surface3
    val linkColor = MaterialTheme.colorScheme.primary
    Column(modifier = modifier) {
        blocks.forEachIndexed { idx, block ->
            if (idx > 0) {
                // 间距分级：标题前 16 拉开小节，标题后 6 贴住正文，其余 10
                val prev = blocks[idx - 1]
                Spacer(
                    Modifier.height(
                        when {
                            block is MdBlock.Heading -> 16.dp
                            prev is MdBlock.Heading -> 6.dp
                            else -> 10.dp
                        }
                    )
                )
            }
            when (block) {
                is MdBlock.Heading -> Text(
                    inline(block.text, codeBg, linkColor),
                    style = when (block.level) {
                        1 -> MaterialTheme.typography.titleLarge
                        2 -> MaterialTheme.typography.titleMedium
                        else -> MaterialTheme.typography.titleSmall
                    },
                )

                is MdBlock.Paragraph -> Text(
                    inline(block.text, codeBg, linkColor),
                    style = MaterialTheme.typography.bodyLarge,
                )

                is MdBlock.Code -> CodeBlock(block.lang, block.text)

                is MdBlock.Quote -> Row(Modifier.padding(vertical = 2.dp)) {
                    Box(
                        Modifier
                            .width(3.dp)
                            .fillMaxHeight()
                            .background(MaterialTheme.colorScheme.outline)
                    )
                    Text(
                        inline(block.lines.joinToString("\n"), codeBg, linkColor),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 10.dp),
                    )
                }

                is MdBlock.ListBlock -> Column {
                    block.items.forEachIndexed { n, item ->
                        Row(Modifier.padding(top = if (n > 0) 4.dp else 0.dp)) {
                            Text(
                                if (block.ordered) "${n + 1}. " else "•  ",
                                style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                inline(item, codeBg, linkColor),
                                style = MaterialTheme.typography.bodyLarge,
                            )
                        }
                    }
                }

                is MdBlock.Table -> MdTable(block, codeBg, linkColor)

                MdBlock.Rule -> Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp)
                        .height(1.dp)
                        .background(MaterialTheme.colorScheme.outlineVariant)
                )
            }
        }
    }
}

/** 代码块：语言 header + 一键复制，等宽 13/19，横向滚动 */
@Composable
private fun CodeBlock(lang: String, code: String) {
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1500)
            copied = false
        }
    }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(ownwardColors.Surface1)
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(32.dp)
                .background(ownwardColors.Surface3)
                .padding(start = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                lang.ifBlank { "code" },
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
                color = ownwardColors.TextDim,
            )
            Spacer(Modifier.weight(1f))
            IconButton(
                onClick = {
                    clipboard.setText(AnnotatedString(code))
                    copied = true
                },
                modifier = Modifier.size(32.dp),
            ) {
                Icon(
                    if (copied) Icons.Filled.Check else Icons.Filled.ContentCopy,
                    "复制代码",
                    tint = if (copied) ownwardColors.Success else ownwardColors.TextDim,
                    modifier = Modifier.size(14.dp),
                )
            }
        }
        Text(
            code,
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            lineHeight = 19.sp,
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(12.dp),
        )
    }
}

/** 表格：等分列宽 + hairline 分隔；agent 输出里表格是高频内容 */
@Composable
private fun MdTable(
    table: MdBlock.Table,
    codeBg: androidx.compose.ui.graphics.Color,
    linkColor: androidx.compose.ui.graphics.Color,
) {
    val cols = table.header.size
    val shape = RoundedCornerShape(10.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .border(1.dp, ownwardColors.OutlineFaint, shape)
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .background(ownwardColors.Surface2)
                .padding(horizontal = 10.dp, vertical = 8.dp)
        ) {
            table.header.forEach { h ->
                Text(
                    inline(h, codeBg, linkColor),
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.weight(1f).padding(end = 6.dp),
                )
            }
        }
        table.rows.forEach { r ->
            Box(Modifier.fillMaxWidth().height(1.dp).background(ownwardColors.OutlineFaint))
            Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp)) {
                (0 until cols).forEach { c ->
                    Text(
                        inline(r.getOrElse(c) { "" }, codeBg, linkColor),
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.weight(1f).padding(end = 6.dp),
                    )
                }
            }
        }
    }
}
