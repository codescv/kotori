package dev.kotori.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class DirectInstallCoordinatorTest {

    private static final String APK = "/data/user/0/dev.kotori.app/cache/updates/kotori-0.1.34.apk";

    @Test
    public void apkReadyWithPermission_launchesInstallerImmediately() {
        DirectInstallCoordinator c = new DirectInstallCoordinator();
        assertEquals(DirectInstallCoordinator.Action.LAUNCH_INSTALLER, c.onApkReady(APK, true));
        assertFalse(c.hasPending());
        assertNull(c.getPendingApkPath());
    }

    @Test
    public void apkReadyWithoutPermission_requestsPermissionAndKeepsPending() {
        DirectInstallCoordinator c = new DirectInstallCoordinator();
        assertEquals(DirectInstallCoordinator.Action.REQUEST_PERMISSION, c.onApkReady(APK, false));
        assertTrue(c.hasPending());
        assertEquals(APK, c.getPendingApkPath());
    }

    @Test
    public void foregroundAfterGrant_autoLaunchesInstallerOnce() {
        DirectInstallCoordinator c = new DirectInstallCoordinator();
        c.onApkReady(APK, false);
        assertEquals(DirectInstallCoordinator.Action.LAUNCH_INSTALLER, c.onAppForegrounded(true, true));
        assertFalse(c.hasPending());
        // A second resume (e.g. returning from the system installer) must not relaunch it.
        assertEquals(DirectInstallCoordinator.Action.NONE, c.onAppForegrounded(true, true));
    }

    @Test
    public void foregroundWithoutGrant_keepsWaiting() {
        DirectInstallCoordinator c = new DirectInstallCoordinator();
        c.onApkReady(APK, false);
        assertEquals(DirectInstallCoordinator.Action.NONE, c.onAppForegrounded(false, true));
        assertTrue(c.hasPending());
        assertEquals(DirectInstallCoordinator.Action.LAUNCH_INSTALLER, c.onAppForegrounded(true, true));
    }

    @Test
    public void foregroundWithMissingFile_dropsPending() {
        DirectInstallCoordinator c = new DirectInstallCoordinator();
        c.onApkReady(APK, false);
        assertEquals(DirectInstallCoordinator.Action.NONE, c.onAppForegrounded(true, false));
        assertFalse(c.hasPending());
    }

    @Test
    public void foregroundWithoutPending_doesNothing() {
        DirectInstallCoordinator c = new DirectInstallCoordinator();
        assertEquals(DirectInstallCoordinator.Action.NONE, c.onAppForegrounded(true, true));
    }

    @Test
    public void retriggerAfterGrant_clearsPendingAndLaunches() {
        DirectInstallCoordinator c = new DirectInstallCoordinator();
        c.onApkReady(APK, false);
        // User grants permission and re-taps 「安装更新」 before onResume fires.
        assertEquals(DirectInstallCoordinator.Action.LAUNCH_INSTALLER, c.onApkReady(APK, true));
        assertFalse(c.hasPending());
        assertEquals(DirectInstallCoordinator.Action.NONE, c.onAppForegrounded(true, true));
    }

    @Test
    public void blankPathAndClearPending() {
        DirectInstallCoordinator c = new DirectInstallCoordinator();
        assertEquals(DirectInstallCoordinator.Action.NONE, c.onApkReady(null, true));
        assertEquals(DirectInstallCoordinator.Action.NONE, c.onApkReady("  ", false));
        assertFalse(c.hasPending());
        c.onApkReady(APK, false);
        c.clearPending();
        assertFalse(c.hasPending());
    }
}
