package ai.ownward.app.ui

// 斜杠命令补全的匹配规则（对齐 web/app.js 的 bindComposer + ios UI/Slash.swift）。
// 纯逻辑、不碰 Compose，好让「整条是 /词 才提示」「命中排序」这套口径能直接跑 JVM 测试——
// 三端各写各的匹配，迟早漂成三种行为。

data class SlashCmd(val name: String, val desc: String)

object Slash {
    /**
     * ownward 自己解释的命令（/new、/clear 由 workbench.ts 的 /api/dev/send 拦下，
     * /btw 由忙时输入队列识别）；其余 / 开头一律原样透传给 agent，认识的执行、不认识的回说明。
     */
    val LOCAL = listOf(
        SlashCmd("new", "同任务丢上下文重开"),
        SlashCmd("clear", "同 /new"),
        SlashCmd("btw", "忙时补一句背景，不打断本轮"),
    )

    /**
     * 只在「整条输入就是一个 / 开头的词」时提示（web 的 /^\/(\S*)$/）：
     * 打出空格 = 命令已选定，开始写参数了，这时候还弹菜单只会挡住正文。
     * 返回 null = 不该弹菜单；返回 "" = 刚打了个 "/"，全表都算命中。
     */
    fun query(input: String): String? {
        if (!input.startsWith("/")) return null
        val rest = input.substring(1)
        return if (rest.any { it.isWhitespace() }) null else rest
    }

    /**
     * 候选表：本地命令在前，服务端下发的 slash_commands 去重接在后面（同名以本地的说明为准）。
     * commands 为 null 表示这个输入框不该有补全（非 claude 引擎 / AI 对话）。
     */
    fun all(commands: List<String>?): List<SlashCmd>? {
        if (commands == null) return null
        val localNames = LOCAL.map { it.name }.toSet()
        return LOCAL + commands.filterNot { it in localNames }.map { SlashCmd(it, "") }
    }

    /** 命中项。包含即命中（忽略大小写），前缀命中排前面，其次按名字排——最多 40 条。 */
    fun matches(input: String, commands: List<String>?): List<SlashCmd> {
        val all = all(commands) ?: return emptyList()
        val q = query(input)?.lowercase() ?: return emptyList()
        return all.filter { it.name.lowercase().contains(q) }
            .sortedWith(
                compareByDescending<SlashCmd> { it.name.lowercase().startsWith(q) }
                    .thenBy { it.name }
            )
            .take(40)
    }

    /** 选中一条：整条输入换成 "/name "，光标落在末尾直接写参数 */
    fun accept(cmd: SlashCmd): String = "/${cmd.name} "
}
