package ai.ownward.app.ui

import java.util.Locale

// 界面语言。App 现有文案只有中文；新加的文案按 tr(中文, English) 两套给，跟随系统语言列表——
// 口径对齐 web/i18n.js 的 auto：语言列表里有任一中文就用中文，否则英文（ios Core/Lang.swift 同口径）。
enum class UiLang {
    ZH, EN;

    companion object {
        fun resolve(tags: List<String>): UiLang = if (tags.any { it.lowercase().startsWith("zh") }) ZH else EN

        val current: UiLang by lazy {
            // LocaleList 在纯 JVM 单测里是桩（调用即抛），退回 JVM 默认 Locale
            val tags = runCatching { android.os.LocaleList.getDefault().toLanguageTags().split(',') }
                .getOrElse { listOf(Locale.getDefault().toLanguageTag()) }
            resolve(tags)
        }
    }
}

fun tr(zh: String, en: String): String = if (UiLang.current == UiLang.ZH) zh else en
