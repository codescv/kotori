package dev.kotori.app;

/**
 * v0.1.34 pure-Java (Android-free, unit-testable) state machine for the in-app update
 * "download → verify → install directly" flow.
 *
 * <ul>
 *   <li>{@link #onApkReady}: called as soon as the downloaded APK passed verification (or when the
 *       user re-taps 「安装更新」). Launches the installer immediately when the
 *       "install unknown apps" permission is granted; otherwise records the APK as pending and asks
 *       for {@code ACTION_MANAGE_UNKNOWN_APP_SOURCES}.</li>
 *   <li>{@link #onAppForegrounded}: called from the plugin's {@code handleOnResume}. If an APK is
 *       pending and the permission is now granted, clears the pending flag and launches the
 *       installer automatically — no second tap required.</li>
 * </ul>
 */
final class DirectInstallCoordinator {

    enum Action {
        /** Nothing to launch (no pending APK, permission still missing, or APK file gone). */
        NONE,
        /** Launch the system package installer right away. */
        LAUNCH_INSTALLER,
        /** Open {@code ACTION_MANAGE_UNKNOWN_APP_SOURCES}; the APK stays pending until resume. */
        REQUEST_PERMISSION
    }

    private volatile String pendingApkPath;

    /** Path of the APK waiting for the unknown-sources permission, or {@code null}. */
    String getPendingApkPath() {
        return pendingApkPath;
    }

    boolean hasPending() {
        return pendingApkPath != null;
    }

    synchronized Action onApkReady(String apkPath, boolean canRequestPackageInstalls) {
        if (apkPath == null || apkPath.trim().isEmpty()) return Action.NONE;
        if (canRequestPackageInstalls) {
            pendingApkPath = null;
            return Action.LAUNCH_INSTALLER;
        }
        pendingApkPath = apkPath;
        return Action.REQUEST_PERMISSION;
    }

    /**
     * @param canRequestPackageInstalls current {@code PackageManager#canRequestPackageInstalls()}
     * @param pendingFileExists whether {@link #getPendingApkPath()} still exists on disk
     */
    synchronized Action onAppForegrounded(boolean canRequestPackageInstalls, boolean pendingFileExists) {
        if (pendingApkPath == null) return Action.NONE;
        if (!canRequestPackageInstalls) return Action.NONE;
        pendingApkPath = null;
        return pendingFileExists ? Action.LAUNCH_INSTALLER : Action.NONE;
    }

    synchronized void clearPending() {
        pendingApkPath = null;
    }
}
