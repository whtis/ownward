package ai.ownward.app.ui

import ai.ownward.app.data.AppJson
import ai.ownward.app.data.ProvidersUsage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// 额度一行（对齐 web/tasks.js usagePillHtml、iOS UsageLabelTests）：标签格式、距重置时间、变色阈值
class UsageLabelTest {
    private val now = 1_800_000_000_000L   // 2027-01-15T08:00:00Z
    private fun usage(json: String) = AppJson.decodeFromString(ProvidersUsage.serializer(), json)

    @Test fun labelFollowsSessionEngineAndShowsTimeToReset() {
        val u = usage("""{"ok":true,"claude":{"windows":[{"label":"5h","seconds":18000,"percent":46.4,"resetsAt":"2027-01-15T11:10:00.000Z"},{"label":"周","seconds":604800,"percent":42,"resetsAt":"2027-01-17T10:00:00+00:00"}]},"codex":{"windows":[{"label":"周","seconds":604800,"percent":91}],"plan":"pro"}}""")
        assertEquals("额度 5h 46%(3h10m) · 周 42%(2d2h)", usageLabel(u.forProvider("claude"), now))
        assertEquals("额度 周 91%", usageLabel(u.forProvider("codex"), now))
        assertNull(usageLabel(u.forProvider("codebuddy"), now))
        assertEquals(2, usageSeverity(u.forProvider("codex")))
        assertEquals(0, usageSeverity(u.forProvider("claude")))
    }

    @Test fun staleOrBrokenResetTimesDropTheParenthesis() {
        assertEquals("", usageEta("not-a-date", now))
        assertEquals("", usageEta("2027-01-15T07:59:00Z", now))
        assertEquals("45m", usageEta("2027-01-15T08:45:00Z", now))
        assertNull(usageLabel(null, now))
        assertNull(usageLabel(usage("""{"claude":{"windows":[]}}""").claude, now))
    }
}
