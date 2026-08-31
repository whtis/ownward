package ai.ownward.app

import ai.ownward.app.data.normalizeTopLevelRoot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RootNavigationTest {
    @Test fun persistedRootOnlyAcceptsTopLevelAllowlist() {
        assertEquals("inbox", normalizeTopLevelRoot("inbox"))
        assertEquals("agent", normalizeTopLevelRoot("agent"))
        assertEquals("chat", normalizeTopLevelRoot("chat"))
        assertEquals("chat", normalizeTopLevelRoot(null))
        assertEquals("chat", normalizeTopLevelRoot("task/123"))
        assertEquals("chat", normalizeTopLevelRoot("settings"))
    }

    @Test fun detailRoutesPersistTheirOwningTopLevelRoot() {
        assertEquals("inbox", topLevelRootForRoute("inbox"))
        assertEquals("inbox", topLevelRootForRoute("settings"))
        assertEquals("agent", topLevelRootForRoute("agent"))
        assertEquals("agent", topLevelRootForRoute("dispatch"))
        assertEquals("agent", topLevelRootForRoute("task/{id}"))
        assertEquals("agent", topLevelRootForRoute("observe?id={id}&task={task}"))
        assertEquals("chat", topLevelRootForRoute("chat"))
        assertEquals("chat", topLevelRootForRoute("chatDetail?id={id}"))
    }

    @Test fun transientOrUnknownDestinationsDoNotOverwritePersistedRoot() {
        assertNull(topLevelRootForRoute(null))
        assertNull(topLevelRootForRoute("setup"))
        assertNull(topLevelRootForRoute("future/detail"))
    }

    @Test fun onlyColdChatRootAutoOpensANewChat() {
        assertEquals(true, shouldOpenNewChatOnLaunch("chat", restoringActivityState = false))
        assertEquals(false, shouldOpenNewChatOnLaunch("chat", restoringActivityState = true))
        assertEquals(false, shouldOpenNewChatOnLaunch("inbox", restoringActivityState = false))
        assertEquals(false, shouldOpenNewChatOnLaunch("agent", restoringActivityState = false))
    }

    @Test fun navHostAndPopUpOperationsShareTheValidatedGraphRoot() {
        assertEquals("inbox", navigationGraphRoot("inbox"))
        assertEquals("agent", navigationGraphRoot("agent"))
        assertEquals("chat", navigationGraphRoot("chat"))
        assertEquals("chat", navigationGraphRoot("task/123"))
    }
}
