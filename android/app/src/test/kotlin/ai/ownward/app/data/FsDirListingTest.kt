package ai.ownward.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URLDecoder

class FsDirListingTest {
    @Test
    fun fsDirsPathEncodesSpacesHashChineseAndSlashes() {
        val path = "/Users/example/全部 工作/#草稿"
        val requestPath = fsDirsPath(path)

        assertEquals(
            "/api/fs/dirs?path=%2FUsers%2Fexample%2F%E5%85%A8%E9%83%A8+%E5%B7%A5%E4%BD%9C%2F%23%E8%8D%89%E7%A8%BF",
            requestPath,
        )
        assertEquals(path, URLDecoder.decode(requestPath.substringAfter("path="), "UTF-8"))
    }

    @Test
    fun decodesRootListingAndGitMarker() {
        val listing = AppJson.decodeFromString<FsDirListing>(
            """{"ok":true,"path":null,"parent":null,"entries":[{"name":"/srv/work","path":"/srv/work","git":true}],"truncated":false}""",
        )

        assertTrue(listing.ok)
        assertNull(listing.path)
        assertNull(listing.parent)
        assertEquals("/srv/work", listing.entries.single().path)
        assertTrue(listing.entries.single().git)
        assertFalse(listing.truncated)
    }

    @Test
    fun decodesTruncatedChildListing() {
        val listing = AppJson.decodeFromString<FsDirListing>(
            """{"ok":true,"path":"/srv/work","parent":null,"entries":[],"truncated":true}""",
        )

        assertEquals("/srv/work", listing.path)
        assertTrue(listing.truncated)
    }
}
