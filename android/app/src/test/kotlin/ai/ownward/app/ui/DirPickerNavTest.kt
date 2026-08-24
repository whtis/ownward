package ai.ownward.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class DirPickerNavTest {
    @Test
    fun initialPathFailureFallsBackToRootsOnlyOnce() {
        val retryAtRoots = DirPickerNav("/missing/path").failed()!!

        assertNull(retryAtRoots.requestedPath)
        assertFalse(retryAtRoots.canFallbackToRoots)
        assertNull(retryAtRoots.failed())
    }

    @Test
    fun successfulLoadDisablesFallbackAndParentCanNavigateToRoots() {
        val loaded = DirPickerNav("/allowed/project").loaded()
        assertNull(loaded.failed())

        val parent = loaded.go("/allowed")
        assertEquals("/allowed", parent.requestedPath)
        assertFalse(parent.canFallbackToRoots)

        val roots = parent.go(null)
        assertNull(roots.requestedPath)
        assertFalse(roots.canFallbackToRoots)
    }
}
