package dev.kotori.app;

import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.net.URL;
import java.net.URLDecoder;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.BitSet;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONException;

/**
 * Native Android BitTorrent engine & external intent launcher for Kotori.
 *
 * Supports:
 * - Fetching `.torrent` files over HTTP(S) or resolving magnet links via BEP 10 / BEP 9 `ut_metadata`
 * - HTTP/HTTPS & UDP (BEP 15) tracker announces
 * - Multi-peer TCP BitTorrent wire protocol with pipelined 16 KiB block requests
 * - SHA-1 piece verification & direct RandomAccessFile disk storage
 */
@CapacitorPlugin(name = "KotoriTorrent")
public class KotoriTorrentPlugin extends Plugin {
    private static final int BLOCK_SIZE = 16384;
    private static final int MAX_INFLIGHT = 16;
    private static final String[] DEFAULT_TRACKERS = new String[] {
        "http://nyaa.tracker.wf:7777/announce",
        "udp://open.stealth.si:80/announce",
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://exodus.desync.com:6969/announce",
        "udp://tracker.torrent.eu.org:451/announce"
    };

    private static final String DEFAULT_ICON_ID = "s4-01";
    private static final Map<String, String> ICON_ALIASES;
    static {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("s4-01", "dev.kotori.app.IconS401");
        m.put("s4-02", "dev.kotori.app.IconS402");
        m.put("s4-03", "dev.kotori.app.IconS403");
        m.put("s4-04", "dev.kotori.app.IconS404");
        m.put("s3-01", "dev.kotori.app.IconS301");
        m.put("s3-02", "dev.kotori.app.IconS302");
        m.put("s3-03", "dev.kotori.app.IconS303");
        m.put("s3-04", "dev.kotori.app.IconS304");
        ICON_ALIASES = Collections.unmodifiableMap(m);
    }

    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Map<String, TorrentSession> sessions = new ConcurrentHashMap<>();
    private final byte[] peerId = generatePeerId();

    private static byte[] generatePeerId() {
        byte[] id = new byte[20];
        byte[] prefix = "-KT0110-".getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(prefix, 0, id, 0, prefix.length);
        String chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
        SecureRandom rng = new SecureRandom();
        for (int i = prefix.length; i < 20; i++) {
            id[i] = (byte) chars.charAt(rng.nextInt(chars.length()));
        }
        return id;
    }

    private static boolean isAliasEnabled(PackageManager pm, String pkg, String aliasClass, boolean isDefault) {
        int state = pm.getComponentEnabledSetting(new ComponentName(pkg, aliasClass));
        if (state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED) return true;
        if (state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT) return isDefault;
        return false;
    }

    @PluginMethod
    public void setAppIcon(PluginCall call) {
        String iconId = call.getString("iconId", DEFAULT_ICON_ID);
        String targetAlias = ICON_ALIASES.get(iconId);
        if (targetAlias == null) {
            call.reject("Unsupported app icon id: " + iconId);
            return;
        }
        try {
            PackageManager pm = getContext().getPackageManager();
            String pkg = getContext().getPackageName();

            boolean targetAlreadyEnabled = isAliasEnabled(
                pm,
                pkg,
                targetAlias,
                DEFAULT_ICON_ID.equals(iconId)
            );
            boolean othersDisabled = true;
            for (Map.Entry<String, String> entry : ICON_ALIASES.entrySet()) {
                if (entry.getKey().equals(iconId)) continue;
                if (isAliasEnabled(pm, pkg, entry.getValue(), DEFAULT_ICON_ID.equals(entry.getKey()))) {
                    othersDisabled = false;
                    break;
                }
            }

            if (!targetAlreadyEnabled || !othersDisabled) {
                pm.setComponentEnabledSetting(
                    new ComponentName(pkg, targetAlias),
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                    PackageManager.DONT_KILL_APP
                );
                for (Map.Entry<String, String> entry : ICON_ALIASES.entrySet()) {
                    if (entry.getKey().equals(iconId)) continue;
                    pm.setComponentEnabledSetting(
                        new ComponentName(pkg, entry.getValue()),
                        PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                        PackageManager.DONT_KILL_APP
                    );
                }
            }

            JSObject out = new JSObject();
            out.put("iconId", iconId);
            out.put("changed", !targetAlreadyEnabled || !othersDisabled);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Failed to switch app icon: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No installed app can handle link: " + url, e);
        } catch (Exception e) {
            call.reject("Failed to open external link: " + e.getMessage(), e);
        }
    }

    /**
     * Download a release APK to the app cache directory with live progress events
     * (`apkDownloadProgress`) and launch the Android system package installer via
     * `FileProvider`.
     */
    @PluginMethod
    public void downloadAndInstallApk(PluginCall call) {
        final String url = call.getString("url", "");
        final String version = call.getString("version", "latest");
        if (url == null || url.trim().isEmpty()) {
            call.reject("Missing APK download URL");
            return;
        }
        executor.execute(() -> {
            try {
                File updatesDir = new File(getContext().getCacheDir(), "updates");
                if (!updatesDir.exists()) {
                    updatesDir.mkdirs();
                }
                String safeVer = version.replaceAll("[^a-zA-Z0-9._-]", "_");
                File apkFile = new File(updatesDir, "kotori-" + safeVer + ".apk");
                File tmpFile = new File(updatesDir, "kotori-" + safeVer + ".apk.tmp");

                HttpURLConnection conn = null;
                String currentUrl = url.trim();
                for (int redirect = 0; redirect < 6; redirect++) {
                    conn = (HttpURLConnection) new URL(currentUrl).openConnection();
                    conn.setInstanceFollowRedirects(true);
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(60000);
                    conn.setRequestProperty("User-Agent", "Kotori-Updater/1.0");
                    conn.setRequestProperty(
                        "Accept",
                        "application/octet-stream, application/vnd.android.package-archive, */*"
                    );
                    conn.setRequestProperty("Accept-Encoding", "identity");
                    int status = conn.getResponseCode();
                    if (status == HttpURLConnection.HTTP_MOVED_TEMP
                        || status == HttpURLConnection.HTTP_MOVED_PERM
                        || status == HttpURLConnection.HTTP_SEE_OTHER
                        || status == 307
                        || status == 308) {
                        String loc = conn.getHeaderField("Location");
                        conn.disconnect();
                        if (loc == null || loc.isEmpty()) {
                            throw new Exception("Redirect with empty Location header");
                        }
                        currentUrl = loc;
                        continue;
                    }
                    if (status < 200 || status >= 300) {
                        conn.disconnect();
                        throw new Exception("HTTP " + status + " when downloading APK");
                    }
                    break;
                }
                if (conn == null) {
                    throw new Exception("Failed to open connection");
                }

                long totalBytes = conn.getContentLengthLong();
                long downloadedBytes = 0;
                long lastNotifyMs = 0;

                try (InputStream in = conn.getInputStream();
                     FileOutputStream out = new FileOutputStream(tmpFile)) {
                    byte[] buf = new byte[32768];
                    int n;
                    while ((n = in.read(buf)) >= 0) {
                        out.write(buf, 0, n);
                        downloadedBytes += n;
                        long now = System.currentTimeMillis();
                        if (now - lastNotifyMs >= 250 || (totalBytes > 0 && downloadedBytes >= totalBytes)) {
                            lastNotifyMs = now;
                            JSObject progress = new JSObject();
                            progress.put("downloadedBytes", downloadedBytes);
                            progress.put("totalBytes", totalBytes);
                            progress.put(
                                "percent",
                                totalBytes > 0
                                    ? Math.min(100, (int) ((downloadedBytes * 100L) / totalBytes))
                                    : -1
                            );
                            notifyListeners("apkDownloadProgress", progress);
                        }
                    }
                    out.flush();
                } finally {
                    conn.disconnect();
                }

                if (tmpFile.length() < 1024) {
                    tmpFile.delete();
                    throw new Exception("Downloaded file is too small (" + downloadedBytes + " bytes)");
                }
                try (FileInputStream checkIn = new FileInputStream(tmpFile)) {
                    byte[] magic = new byte[4];
                    if (checkIn.read(magic) != 4
                        || magic[0] != 0x50
                        || magic[1] != 0x4B
                        || magic[2] != 0x03
                        || magic[3] != 0x04) {
                        tmpFile.delete();
                        throw new Exception("Downloaded file is not a valid APK package");
                    }
                }
                if (apkFile.exists()) {
                    apkFile.delete();
                }
                if (!tmpFile.renameTo(apkFile)) {
                    throw new Exception("Failed to finalize downloaded APK file");
                }

                boolean launched = launchApkInstaller(apkFile);
                JSObject ret = new JSObject();
                ret.put("filePath", apkFile.getAbsolutePath());
                ret.put("sizeBytes", apkFile.length());
                ret.put("installed", launched);
                ret.put("needsPermission", !launched);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("APK download failed: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Re-trigger the Android package installer for an already-downloaded APK file
     * (e.g. after the user grants "Install unknown apps" permission).
     */
    @PluginMethod
    public void installApkFile(PluginCall call) {
        String filePath = call.getString("filePath", "");
        if (filePath == null || filePath.trim().isEmpty()) {
            call.reject("Missing filePath");
            return;
        }
        File apkFile = new File(filePath);
        if (!apkFile.exists()) {
            call.reject("APK file not found: " + filePath);
            return;
        }
        try {
            boolean launched = launchApkInstaller(apkFile);
            JSObject ret = new JSObject();
            ret.put("installed", launched);
            ret.put("needsPermission", !launched);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to launch APK installer: " + e.getMessage(), e);
        }
    }

    private boolean launchApkInstaller(File apkFile) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (!getContext().getPackageManager().canRequestPackageInstalls()) {
                Intent permIntent = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName())
                );
                permIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(permIntent);
                return false;
            }
        }
        Uri apkUri = FileProvider.getUriForFile(
            getContext(),
            getContext().getPackageName() + ".fileprovider",
            apkFile
        );
        Intent installIntent = new Intent(Intent.ACTION_VIEW);
        installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
        installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getContext().startActivity(installIntent);
        return true;
    }

    @PluginMethod
    public void startTorrent(PluginCall call) {
        String taskId = call.getString("taskId");
        if (taskId == null || taskId.isEmpty()) {
            call.reject("taskId is required");
            return;
        }
        String infoHashHex = call.getString("infoHash", "");
        String magnet = call.getString("magnet", "");
        String torrentUrl = call.getString("torrentUrl", "");
        String targetDir = stripFileUri(call.getString("targetDir", ""));
        int maxPeers = Math.max(4, Math.min(60, call.getInt("maxPeers", 30)));
        JSArray fileIndexesArr = call.getArray("fileIndexes");
        Set<Integer> selectedIndexes = parseIndexArray(fileIndexesArr);

        TorrentSession existing = sessions.remove(taskId);
        if (existing != null) {
            existing.stop("restart");
        }

        TorrentSession session = new TorrentSession(
            taskId,
            infoHashHex,
            magnet,
            torrentUrl,
            targetDir,
            maxPeers,
            selectedIndexes
        );
        sessions.put(taskId, session);
        session.start();
        call.resolve();
    }

    @PluginMethod
    public void pauseTorrent(PluginCall call) {
        String taskId = call.getString("taskId");
        TorrentSession session = taskId != null ? sessions.remove(taskId) : null;
        if (session != null) {
            session.stop("pause");
        }
        call.resolve();
    }

    @PluginMethod
    public void cancelTorrent(PluginCall call) {
        String taskId = call.getString("taskId");
        boolean deleteFiles = Boolean.TRUE.equals(call.getBoolean("deleteFiles", true));
        TorrentSession session = taskId != null ? sessions.remove(taskId) : null;
        if (session != null) {
            session.stop("cancel");
            if (deleteFiles) {
                deleteRecursive(new File(session.targetDir));
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void selectFiles(PluginCall call) {
        String taskId = call.getString("taskId");
        JSArray arr = call.getArray("fileIndexes");
        TorrentSession session = taskId != null ? sessions.get(taskId) : null;
        if (session == null) {
            call.reject("Torrent session not active: " + taskId);
            return;
        }
        Set<Integer> indices = parseIndexArray(arr);
        JSObject out = session.updateSelectedFiles(indices);
        call.resolve(out);
    }

    private static Set<Integer> parseIndexArray(JSArray arr) {
        if (arr == null) return null;
        Set<Integer> set = new LinkedHashSet<>();
        for (int i = 0; i < arr.length(); i++) {
            try {
                set.add(arr.getInt(i));
            } catch (JSONException ignored) {}
        }
        return set;
    }

    private static String stripFileUri(String path) {
        if (path == null) return "";
        if (path.startsWith("file://")) {
            return path.substring("file://".length());
        }
        return path;
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) {
                for (File c : children) deleteRecursive(c);
            }
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private final class TorrentSession {
        final String taskId;
        String infoHashHex;
        byte[] infoHashBytes;
        final String magnet;
        final String torrentUrl;
        final String targetDir;
        final int maxPeers;
        volatile Set<Integer> selectedFiles;

        final AtomicBoolean stopped = new AtomicBoolean(false);
        volatile String stopReason = "";
        final Set<String> trackers = Collections.synchronizedSet(new LinkedHashSet<>());
        final Set<String> activePeers = ConcurrentHashMap.newKeySet();
        final Set<Socket> openSockets = ConcurrentHashMap.newKeySet();

        volatile TorrentMeta meta;
        final AtomicLong downloadedBytes = new AtomicLong(0);
        final AtomicLong windowBytes = new AtomicLong(0);

        TorrentSession(
            String taskId,
            String infoHashHex,
            String magnet,
            String torrentUrl,
            String targetDir,
            int maxPeers,
            Set<Integer> selectedFiles
        ) {
            this.taskId = taskId;
            this.infoHashHex = infoHashHex != null ? infoHashHex.toLowerCase(Locale.ROOT) : "";
            this.magnet = magnet != null ? magnet : "";
            this.torrentUrl = torrentUrl != null ? torrentUrl : "";
            this.targetDir = targetDir;
            this.maxPeers = maxPeers;
            this.selectedFiles = selectedFiles;
            Collections.addAll(this.trackers, DEFAULT_TRACKERS);
            parseMagnetInto(this.magnet);
            if (this.infoHashHex.length() == 40) {
                this.infoHashBytes = hexToBytes(this.infoHashHex);
            }
        }

        void parseMagnetInto(String uri) {
            if (uri == null || !uri.startsWith("magnet:?")) return;
            String query = uri.substring("magnet:?".length());
            for (String part : query.split("&")) {
                int eq = part.indexOf('=');
                if (eq <= 0) continue;
                String k = part.substring(0, eq);
                String v = URLDecoder.decode(part.substring(eq + 1), StandardCharsets.UTF_8);
                if ("xt".equals(k) && v.startsWith("urn:btih:")) {
                    String hash = v.substring("urn:btih:".length()).trim();
                    if (hash.length() == 40) {
                        this.infoHashHex = hash.toLowerCase(Locale.ROOT);
                    }
                } else if ("tr".equals(k) && !v.isEmpty()) {
                    this.trackers.add(v);
                }
            }
        }

        void start() {
            executor.submit(this::runLoop);
        }

        void stop(String reason) {
            stopReason = reason;
            if (stopped.compareAndSet(false, true)) {
                for (Socket s : openSockets) {
                    try {
                        s.close();
                    } catch (IOException ignored) {}
                }
                openSockets.clear();
            }
        }

        synchronized JSObject updateSelectedFiles(Set<Integer> indices) {
            this.selectedFiles = indices;
            TorrentMeta m = this.meta;
            if (m != null) {
                m.applySelection(indices);
            }
            return buildEvent("downloading", null);
        }

        private void runLoop() {
            try {
                emitStatus("resolving", null);
                TorrentMeta resolved = resolveMeta();
                if (stopped.get()) return;
                if (resolved == null) {
                    emitStatus("failed", "Could not resolve torrent metadata (no peers or .torrent unavailable)");
                    return;
                }
                this.meta = resolved;
                if (this.selectedFiles != null) {
                    resolved.applySelection(this.selectedFiles);
                }
                resolved.prepareFiles(new File(targetDir), downloadedBytes);
                if (resolved.isComplete()) {
                    emitStatus("completed", null);
                    sessions.remove(taskId);
                    return;
                }
                emitStatus("downloading", null);

                // Launch periodic progress reporter & tracker announcer
                long[] lastReportTime = new long[] { System.currentTimeMillis() };
                long[] currentSpeed = new long[] { 0 };

                while (!stopped.get() && !resolved.isComplete()) {
                    List<InetSocketAddress> peers = announceAllTrackers(resolved.totalSelectedBytes() - downloadedBytes.get());
                    if (stopped.get()) break;
                    for (InetSocketAddress addr : peers) {
                        if (stopped.get() || resolved.isComplete()) break;
                        String key = addr.getHostString() + ":" + addr.getPort();
                        if (activePeers.size() >= maxPeers || !activePeers.add(key)) continue;
                        executor.submit(() -> {
                            try {
                                runPeer(addr, resolved);
                            } finally {
                                activePeers.remove(key);
                            }
                        });
                    }

                    // Wait up to 15s before next tracker cycle, emitting progress every 500ms
                    for (int tick = 0; tick < 30 && !stopped.get() && !resolved.isComplete(); tick++) {
                        Thread.sleep(500);
                        long now = System.currentTimeMillis();
                        long elapsed = now - lastReportTime[0];
                        if (elapsed >= 1000) {
                            long bytes = windowBytes.getAndSet(0);
                            currentSpeed[0] = (bytes * 1000L) / elapsed;
                            lastReportTime[0] = now;
                        }
                        notifyListeners("torrentProgress", buildEvent("downloading", null, currentSpeed[0]));
                    }
                }

                if (!stopped.get() && resolved.isComplete()) {
                    emitStatus("completed", null);
                    sessions.remove(taskId);
                }
            } catch (Exception e) {
                if (!stopped.get()) {
                    emitStatus("failed", e.getMessage() != null ? e.getMessage() : e.toString());
                    sessions.remove(taskId);
                }
            }
        }

        private TorrentMeta resolveMeta() throws Exception {
            if (!torrentUrl.isEmpty() && (torrentUrl.startsWith("http://") || torrentUrl.startsWith("https://"))) {
                try {
                    byte[] bytes = httpGetBytes(torrentUrl, 25000);
                    TorrentMeta parsed = TorrentMeta.fromTorrentFile(bytes, trackers);
                    this.infoHashBytes = parsed.infoHash;
                    this.infoHashHex = bytesToHex(parsed.infoHash);
                    return parsed;
                } catch (Exception e) {
                    if (infoHashBytes == null) throw e;
                }
            }
            if (infoHashBytes == null) {
                throw new IOException("Missing valid torrentUrl or 40-char hex infoHash");
            }
            // Resolve metadata via BEP 9 ut_metadata from peers
            for (int round = 0; round < 4 && !stopped.get(); round++) {
                List<InetSocketAddress> peers = announceAllTrackers(16384);
                AtomicInteger idx = new AtomicInteger(0);
                List<TorrentMeta> found = Collections.synchronizedList(new ArrayList<>());
                int workers = Math.min(12, peers.size());
                Thread[] threads = new Thread[workers];
                for (int w = 0; w < workers; w++) {
                    threads[w] = new Thread(() -> {
                        while (!stopped.get() && found.isEmpty()) {
                            int i = idx.getAndIncrement();
                            if (i >= peers.size()) break;
                            TorrentMeta m = tryFetchMetadataFromPeer(peers.get(i));
                            if (m != null) {
                                found.add(m);
                                break;
                            }
                        }
                    });
                    threads[w].start();
                }
                for (Thread t : threads) {
                    t.join(12000);
                }
                if (!found.isEmpty()) return found.get(0);
            }
            return null;
        }

        private TorrentMeta tryFetchMetadataFromPeer(InetSocketAddress addr) {
            try (Socket socket = new Socket()) {
                openSockets.add(socket);
                socket.connect(addr, 6000);
                socket.setSoTimeout(10000);
                socket.setTcpNoDelay(true);
                DataOutputStream out = new DataOutputStream(socket.getOutputStream());
                DataInputStream in = new DataInputStream(socket.getInputStream());

                // Send handshake with BEP 10 extension bit (reserved[5] |= 0x10)
                out.writeByte(19);
                out.write("BitTorrent protocol".getBytes(StandardCharsets.US_ASCII));
                byte[] reserved = new byte[8];
                reserved[5] = 0x10;
                out.write(reserved);
                out.write(infoHashBytes);
                out.write(peerId);
                out.flush();

                int pstrlen = in.readUnsignedByte();
                if (pstrlen != 19) return null;
                byte[] pstr = new byte[19];
                in.readFully(pstr);
                byte[] peerRes = new byte[8];
                in.readFully(peerRes);
                byte[] peerHash = new byte[20];
                in.readFully(peerHash);
                if (!Arrays.equals(peerHash, infoHashBytes)) return null;
                byte[] remotePeerId = new byte[20];
                in.readFully(remotePeerId);
                if ((peerRes[5] & 0x10) == 0) return null;

                // Send extended handshake: d1:md11:ut_metadatai1eee
                byte[] extHandshake = "d1:md11:ut_metadatai1eee".getBytes(StandardCharsets.US_ASCII);
                sendExtended(out, 0, extHandshake);

                int peerUtMetadataId = -1;
                int metadataSize = -1;
                byte[][] metaPieces = null;
                int receivedPieces = 0;

                long deadline = System.currentTimeMillis() + 12000;
                while (System.currentTimeMillis() < deadline && !stopped.get()) {
                    int len = in.readInt();
                    if (len == 0) continue;
                    if (len < 0 || len > 2 * 1024 * 1024) return null;
                    int id = in.readUnsignedByte();
                    byte[] payload = new byte[len - 1];
                    in.readFully(payload);
                    if (id != 20 || payload.length < 1) continue;
                    int extId = payload[0] & 0xFF;
                    byte[] body = Arrays.copyOfRange(payload, 1, payload.length);
                    if (extId == 0) {
                        Bencode.Result dec = Bencode.decode(body, 0);
                        Map<String, Object> dict = Bencode.asMap(dec.value);
                        Map<String, Object> m = Bencode.asMap(dict.get("m"));
                        if (m != null && m.get("ut_metadata") instanceof Number) {
                            peerUtMetadataId = ((Number) m.get("ut_metadata")).intValue();
                        }
                        if (dict.get("metadata_size") instanceof Number) {
                            metadataSize = ((Number) dict.get("metadata_size")).intValue();
                        }
                        if (peerUtMetadataId > 0 && metadataSize > 0 && metadataSize <= 8 * 1024 * 1024) {
                            int numPieces = (metadataSize + BLOCK_SIZE - 1) / BLOCK_SIZE;
                            metaPieces = new byte[numPieces][];
                            for (int p = 0; p < numPieces; p++) {
                                String req = "d8:msg_typei0e5:piecei" + p + "ee";
                                sendExtended(out, peerUtMetadataId, req.getBytes(StandardCharsets.US_ASCII));
                            }
                        }
                    } else if (extId == 1 && metaPieces != null) {
                        Bencode.Result header = Bencode.decode(body, 0);
                        Map<String, Object> hmap = Bencode.asMap(header.value);
                        int msgType = hmap.get("msg_type") instanceof Number ? ((Number) hmap.get("msg_type")).intValue() : -1;
                        int piece = hmap.get("piece") instanceof Number ? ((Number) hmap.get("piece")).intValue() : -1;
                        if (msgType == 1 && piece >= 0 && piece < metaPieces.length && metaPieces[piece] == null) {
                            metaPieces[piece] = Arrays.copyOfRange(body, header.nextIndex, body.length);
                            receivedPieces++;
                            if (receivedPieces == metaPieces.length) {
                                ByteArrayOutputStream bos = new ByteArrayOutputStream(metadataSize);
                                for (byte[] mp : metaPieces) bos.write(mp);
                                byte[] rawInfo = bos.toByteArray();
                                byte[] sha = sha1(rawInfo);
                                if (Arrays.equals(sha, infoHashBytes)) {
                                    return TorrentMeta.fromInfoBytes(rawInfo, infoHashBytes);
                                }
                                return null;
                            }
                        }
                    }
                }
            } catch (Exception ignored) {
            }
            return null;
        }

        private void sendExtended(DataOutputStream out, int extId, byte[] body) throws IOException {
            out.writeInt(2 + body.length);
            out.writeByte(20);
            out.writeByte(extId);
            out.write(body);
            out.flush();
        }

        private void runPeer(InetSocketAddress addr, TorrentMeta m) {
            int currentPiece = -1;
            try (Socket socket = new Socket()) {
                openSockets.add(socket);
                socket.connect(addr, 7000);
                socket.setSoTimeout(25000);
                socket.setTcpNoDelay(true);
                DataOutputStream out = new DataOutputStream(socket.getOutputStream());
                DataInputStream in = new DataInputStream(socket.getInputStream());

                out.writeByte(19);
                out.write("BitTorrent protocol".getBytes(StandardCharsets.US_ASCII));
                out.write(new byte[8]);
                out.write(infoHashBytes);
                out.write(peerId);
                out.flush();

                int pstrlen = in.readUnsignedByte();
                if (pstrlen != 19) return;
                byte[] pstr = new byte[19];
                in.readFully(pstr);
                in.skipBytes(8);
                byte[] peerHash = new byte[20];
                in.readFully(peerHash);
                if (!Arrays.equals(peerHash, infoHashBytes)) return;
                byte[] remoteId = new byte[20];
                in.readFully(remoteId);

                // Send interested (id = 2)
                out.writeInt(1);
                out.writeByte(2);
                out.flush();

                BitSet peerHas = new BitSet(m.numPieces);
                boolean choked = true;
                byte[] pieceBuf = null;
                int pieceLen = 0;
                int nextOffset = 0;
                int receivedBytes = 0;
                int inflight = 0;

                while (!stopped.get() && !m.isComplete()) {
                    if (!choked && currentPiece < 0) {
                        currentPiece = m.claimNextPiece(peerHas);
                        if (currentPiece >= 0) {
                            pieceLen = m.pieceSize(currentPiece);
                            pieceBuf = new byte[pieceLen];
                            nextOffset = 0;
                            receivedBytes = 0;
                            inflight = 0;
                        }
                    }
                    while (!choked && currentPiece >= 0 && inflight < MAX_INFLIGHT && nextOffset < pieceLen) {
                        int reqLen = Math.min(BLOCK_SIZE, pieceLen - nextOffset);
                        out.writeInt(13);
                        out.writeByte(6);
                        out.writeInt(currentPiece);
                        out.writeInt(nextOffset);
                        out.writeInt(reqLen);
                        nextOffset += reqLen;
                        inflight++;
                    }
                    out.flush();

                    int msgLen = in.readInt();
                    if (msgLen == 0) continue;
                    if (msgLen < 0 || msgLen > 4 * 1024 * 1024) break;
                    int msgId = in.readUnsignedByte();
                    if (msgId == 0) {
                        choked = true;
                        if (currentPiece >= 0) {
                            m.releasePiece(currentPiece);
                            currentPiece = -1;
                        }
                    } else if (msgId == 1) {
                        choked = false;
                    } else if (msgId == 4) {
                        int pieceIdx = in.readInt();
                        if (pieceIdx >= 0 && pieceIdx < m.numPieces) peerHas.set(pieceIdx);
                    } else if (msgId == 5) {
                        byte[] bf = new byte[msgLen - 1];
                        in.readFully(bf);
                        for (int i = 0; i < m.numPieces; i++) {
                            int byteIdx = i >> 3;
                            int bitIdx = 7 - (i & 7);
                            if (byteIdx < bf.length && ((bf[byteIdx] >> bitIdx) & 1) != 0) {
                                peerHas.set(i);
                            }
                        }
                    } else if (msgId == 7) {
                        int idx = in.readInt();
                        int begin = in.readInt();
                        int blockLen = msgLen - 9;
                        if (idx == currentPiece && pieceBuf != null && begin >= 0 && begin + blockLen <= pieceBuf.length) {
                            in.readFully(pieceBuf, begin, blockLen);
                            receivedBytes += blockLen;
                            if (inflight > 0) inflight--;
                            if (receivedBytes >= pieceLen) {
                                if (m.verifyAndWritePiece(currentPiece, pieceBuf, downloadedBytes, windowBytes)) {
                                    currentPiece = -1;
                                    pieceBuf = null;
                                } else {
                                    m.releasePiece(currentPiece);
                                    currentPiece = -1;
                                    break;
                                }
                            }
                        } else {
                            skipFully(in, blockLen);
                        }
                    } else {
                        skipFully(in, msgLen - 1);
                    }
                }
            } catch (EOFException ignored) {
            } catch (Exception ignored) {
            } finally {
                if (currentPiece >= 0) {
                    m.releasePiece(currentPiece);
                }
            }
        }

        private List<InetSocketAddress> announceAllTrackers(long left) {
            Set<InetSocketAddress> found = ConcurrentHashMap.newKeySet();
            List<String> list;
            synchronized (trackers) {
                list = new ArrayList<>(trackers);
            }
            List<Thread> threads = new ArrayList<>();
            for (String tr : list) {
                Thread t = new Thread(() -> {
                    try {
                        if (tr.startsWith("http://") || tr.startsWith("https://")) {
                            found.addAll(announceHttp(tr, left));
                        } else if (tr.startsWith("udp://")) {
                            found.addAll(announceUdp(tr, left));
                        }
                    } catch (Exception ignored) {}
                });
                t.start();
                threads.add(t);
            }
            for (Thread t : threads) {
                try {
                    t.join(5000);
                } catch (InterruptedException ignored) {}
            }
            return new ArrayList<>(found);
        }

        private List<InetSocketAddress> announceHttp(String trackerUrl, long left) throws Exception {
            String sep = trackerUrl.contains("?") ? "&" : "?";
            String fullUrl = trackerUrl + sep
                + "info_hash=" + urlEncodeBytes(infoHashBytes)
                + "&peer_id=" + urlEncodeBytes(peerId)
                + "&port=6881&uploaded=0&downloaded=" + downloadedBytes.get()
                + "&left=" + Math.max(0L, left)
                + "&compact=1&numwant=50";
            byte[] resp = httpGetBytes(fullUrl, 6000);
            Bencode.Result dec = Bencode.decode(resp, 0);
            Map<String, Object> dict = Bencode.asMap(dec.value);
            if (dict == null) return Collections.emptyList();
            Object peersObj = dict.get("peers");
            if (peersObj instanceof byte[]) {
                return parseCompactPeers((byte[]) peersObj, 0);
            }
            return Collections.emptyList();
        }

        private List<InetSocketAddress> announceUdp(String trackerUrl, long left) throws Exception {
            URI uri = new URI(trackerUrl);
            String host = uri.getHost();
            int port = uri.getPort();
            if (host == null || port <= 0) return Collections.emptyList();
            try (DatagramSocket sock = new DatagramSocket()) {
                sock.setSoTimeout(4000);
                InetAddress addr = InetAddress.getByName(host);
                SecureRandom rng = new SecureRandom();
                int tid = rng.nextInt();

                ByteBuffer connectReq = ByteBuffer.allocate(16);
                connectReq.putLong(0x41727101980L);
                connectReq.putInt(0);
                connectReq.putInt(tid);
                byte[] reqBytes = connectReq.array();
                sock.send(new DatagramPacket(reqBytes, reqBytes.length, addr, port));

                byte[] connectResp = new byte[16];
                DatagramPacket respPkt = new DatagramPacket(connectResp, connectResp.length);
                sock.receive(respPkt);
                if (respPkt.getLength() < 16) return Collections.emptyList();
                ByteBuffer cb = ByteBuffer.wrap(connectResp);
                if (cb.getInt() != 0 || cb.getInt() != tid) return Collections.emptyList();
                long connId = cb.getLong();

                int annTid = rng.nextInt();
                ByteBuffer annReq = ByteBuffer.allocate(98);
                annReq.putLong(connId);
                annReq.putInt(1);
                annReq.putInt(annTid);
                annReq.put(infoHashBytes);
                annReq.put(peerId);
                annReq.putLong(downloadedBytes.get());
                annReq.putLong(Math.max(0L, left));
                annReq.putLong(0L);
                annReq.putInt(0);
                annReq.putInt(0);
                annReq.putInt(rng.nextInt());
                annReq.putInt(50);
                annReq.putShort((short) 6881);
                byte[] annBytes = annReq.array();
                sock.send(new DatagramPacket(annBytes, annBytes.length, addr, port));

                byte[] annResp = new byte[1024];
                DatagramPacket annPkt = new DatagramPacket(annResp, annResp.length);
                sock.receive(annPkt);
                if (annPkt.getLength() < 20) return Collections.emptyList();
                ByteBuffer ab = ByteBuffer.wrap(annResp, 0, annPkt.getLength());
                if (ab.getInt() != 1 || ab.getInt() != annTid) return Collections.emptyList();
                return parseCompactPeers(Arrays.copyOfRange(annResp, 20, annPkt.getLength()), 0);
            }
        }

        private void emitStatus(String status, String error) {
            notifyListeners("torrentProgress", buildEvent(status, error, 0));
        }

        private JSObject buildEvent(String status, String error) {
            return buildEvent(status, error, 0);
        }

        private JSObject buildEvent(String status, String error, long speedBps) {
            JSObject obj = new JSObject();
            obj.put("taskId", taskId);
            obj.put("status", status);
            long dl = downloadedBytes.get();
            TorrentMeta m = this.meta;
            long total = m != null ? m.totalSelectedBytes() : 0L;
            obj.put("downloadedBytes", dl);
            if (total > 0) {
                obj.put("totalBytes", total);
                obj.put("progress", Math.min(1.0, (double) dl / (double) total));
                if (speedBps > 0 && dl < total) {
                    obj.put("etaMs", ((total - dl) * 1000L) / speedBps);
                }
            } else {
                obj.put("progress", "completed".equals(status) ? 1.0 : 0.0);
            }
            obj.put("speedBps", speedBps);
            obj.put("peers", activePeers.size());
            if (error != null) {
                obj.put("error", error);
            }
            if (m != null) {
                JSArray filesArr = new JSArray();
                for (TorrentFileEntry f : m.files) {
                    JSObject fo = new JSObject();
                    fo.put("index", f.index);
                    fo.put("path", new File(targetDir, f.relativePath).getAbsolutePath());
                    fo.put("sizeBytes", f.length);
                    fo.put("downloadedBytes", f.downloaded.get());
                    fo.put("selected", f.selected);
                    filesArr.put(fo);
                }
                obj.put("files", filesArr);
            }
            return obj;
        }
    }

    private static final class TorrentFileEntry {
        final int index;
        final String relativePath;
        final long offset;
        final long length;
        volatile boolean selected = true;
        final AtomicLong downloaded = new AtomicLong(0);
        File diskFile;

        TorrentFileEntry(int index, String relativePath, long offset, long length) {
            this.index = index;
            this.relativePath = relativePath;
            this.offset = offset;
            this.length = length;
        }
    }

    private static final class TorrentMeta {
        final byte[] infoHash;
        final String name;
        final int pieceLength;
        final int numPieces;
        final byte[] piecesHashes;
        final long totalLength;
        final List<TorrentFileEntry> files;
        final BitSet completedPieces;
        final BitSet inflightPieces;
        final BitSet wantedPieces;
        final List<Integer> priorityOrder;

        private TorrentMeta(
            byte[] infoHash,
            String name,
            int pieceLength,
            byte[] piecesHashes,
            long totalLength,
            List<TorrentFileEntry> files
        ) {
            this.infoHash = infoHash;
            this.name = name;
            this.pieceLength = pieceLength;
            this.piecesHashes = piecesHashes;
            this.numPieces = piecesHashes.length / 20;
            this.totalLength = totalLength;
            this.files = files;
            this.completedPieces = new BitSet(this.numPieces);
            this.inflightPieces = new BitSet(this.numPieces);
            this.wantedPieces = new BitSet(this.numPieces);
            this.wantedPieces.set(0, this.numPieces);
            this.priorityOrder = new ArrayList<>(this.numPieces);
            if (this.numPieces > 0) {
                this.priorityOrder.add(0);
                if (this.numPieces > 1) this.priorityOrder.add(this.numPieces - 1);
                for (int i = 1; i < this.numPieces - 1; i++) this.priorityOrder.add(i);
            }
        }

        static TorrentMeta fromTorrentFile(byte[] torrentBytes, Set<String> trackersOut) throws IOException {
            Bencode.Result res = Bencode.decode(torrentBytes, 0);
            Map<String, Object> root = Bencode.asMap(res.value);
            if (root == null) throw new IOException("Invalid .torrent file");
            String announce = Bencode.asString(root.get("announce"));
            if (announce != null && !announce.isEmpty()) trackersOut.add(announce);
            Object annList = root.get("announce-list");
            if (annList instanceof List) {
                for (Object tier : (List<?>) annList) {
                    if (tier instanceof List) {
                        for (Object u : (List<?>) tier) {
                            String s = Bencode.asString(u);
                            if (s != null && !s.isEmpty()) trackersOut.add(s);
                        }
                    }
                }
            }
            int[] span = Bencode.findInfoSpan(torrentBytes);
            if (span == null) throw new IOException("Missing info dictionary in .torrent");
            byte[] rawInfo = Arrays.copyOfRange(torrentBytes, span[0], span[1]);
            byte[] infoHash = sha1(rawInfo);
            return fromInfoBytes(rawInfo, infoHash);
        }

        static TorrentMeta fromInfoBytes(byte[] rawInfo, byte[] infoHash) throws IOException {
            Bencode.Result res = Bencode.decode(rawInfo, 0);
            Map<String, Object> info = Bencode.asMap(res.value);
            if (info == null) throw new IOException("Invalid info dictionary");
            String name = Bencode.asString(info.get("name.utf-8"));
            if (name == null || name.isEmpty()) name = Bencode.asString(info.get("name"));
            if (name == null || name.isEmpty()) name = "download";
            name = sanitizeSegment(name);
            int pieceLen = info.get("piece length") instanceof Number ? ((Number) info.get("piece length")).intValue() : 0;
            byte[] pieces = info.get("pieces") instanceof byte[] ? (byte[]) info.get("pieces") : null;
            if (pieceLen <= 0 || pieces == null || pieces.length % 20 != 0) {
                throw new IOException("Invalid piece length or pieces hash table");
            }
            List<TorrentFileEntry> files = new ArrayList<>();
            long offset = 0;
            Object filesObj = info.get("files");
            if (filesObj instanceof List) {
                int idx = 0;
                for (Object item : (List<?>) filesObj) {
                    Map<String, Object> fm = Bencode.asMap(item);
                    if (fm == null) continue;
                    long len = fm.get("length") instanceof Number ? ((Number) fm.get("length")).longValue() : 0L;
                    Object rawPath = fm.get("path.utf-8") instanceof List ? fm.get("path.utf-8") : fm.get("path");
                    List<?> pathList = rawPath instanceof List ? (List<?>) rawPath : Collections.emptyList();
                    StringBuilder sb = new StringBuilder(name);
                    for (Object seg : pathList) {
                        String s = Bencode.asString(seg);
                        if (s != null && !s.isEmpty()) {
                            sb.append('/').append(sanitizeSegment(s));
                        }
                    }
                    files.add(new TorrentFileEntry(idx++, sb.toString(), offset, len));
                    offset += len;
                }
            } else {
                long len = info.get("length") instanceof Number ? ((Number) info.get("length")).longValue() : 0L;
                files.add(new TorrentFileEntry(0, name, 0L, len));
                offset = len;
            }
            return new TorrentMeta(infoHash, name, pieceLen, pieces, offset, files);
        }

        private static String sanitizeSegment(String s) {
            String cleaned = s.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1F]", "_").trim();
            return cleaned.isEmpty() || ".".equals(cleaned) || "..".equals(cleaned) ? "_" : cleaned;
        }

        synchronized void applySelection(Set<Integer> indices) {
            if (indices == null) return;
            wantedPieces.clear();
            for (TorrentFileEntry f : files) {
                f.selected = indices.contains(f.index);
                if (f.selected && f.length > 0) {
                    int firstPiece = (int) (f.offset / pieceLength);
                    int lastPiece = (int) ((f.offset + f.length - 1) / pieceLength);
                    wantedPieces.set(firstPiece, Math.min(numPieces, lastPiece + 1));
                }
            }
        }

        synchronized long totalSelectedBytes() {
            long sum = 0;
            for (TorrentFileEntry f : files) {
                if (f.selected) sum += f.length;
            }
            return sum;
        }

        synchronized boolean isComplete() {
            for (int i = wantedPieces.nextSetBit(0); i >= 0; i = wantedPieces.nextSetBit(i + 1)) {
                if (!completedPieces.get(i)) return false;
            }
            return true;
        }

        int pieceSize(int index) {
            if (index < numPieces - 1) return pieceLength;
            long rem = totalLength - ((long) index * pieceLength);
            return (int) rem;
        }

        void prepareFiles(File baseDir, AtomicLong totalDownloaded) throws IOException {
            for (TorrentFileEntry f : files) {
                f.diskFile = new File(baseDir, f.relativePath);
                File parent = f.diskFile.getParentFile();
                if (parent != null && !parent.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    parent.mkdirs();
                }
            }
            // Verify any already-downloaded pieces on disk for seamless resume
            for (int p = 0; p < numPieces; p++) {
                byte[] existing = readPieceFromDisk(p);
                if (existing != null && verifyPieceHash(p, existing)) {
                    synchronized (this) {
                        completedPieces.set(p);
                    }
                    accountPieceBytes(p, totalDownloaded, null);
                }
            }
        }

        private byte[] readPieceFromDisk(int pieceIdx) {
            int size = pieceSize(pieceIdx);
            byte[] buf = new byte[size];
            long pieceStart = (long) pieceIdx * pieceLength;
            long pieceEnd = pieceStart + size;
            try {
                for (TorrentFileEntry f : files) {
                    long fStart = f.offset;
                    long fEnd = fStart + f.length;
                    if (fEnd <= pieceStart || fStart >= pieceEnd) continue;
                    if (f.diskFile == null || !f.diskFile.exists()) return null;
                    long overlapStart = Math.max(pieceStart, fStart);
                    long overlapEnd = Math.min(pieceEnd, fEnd);
                    int len = (int) (overlapEnd - overlapStart);
                    if (f.diskFile.length() < (overlapStart - fStart) + len) return null;
                    try (RandomAccessFile raf = new RandomAccessFile(f.diskFile, "r")) {
                        raf.seek(overlapStart - fStart);
                        raf.readFully(buf, (int) (overlapStart - pieceStart), len);
                    }
                }
                return buf;
            } catch (Exception e) {
                return null;
            }
        }

        synchronized int claimNextPiece(BitSet peerHas) {
            for (int idx : priorityOrder) {
                if (wantedPieces.get(idx) && !completedPieces.get(idx) && !inflightPieces.get(idx) && peerHas.get(idx)) {
                    inflightPieces.set(idx);
                    return idx;
                }
            }
            // Endgame fallback: allow claiming an in-flight piece if nothing else is free
            for (int idx : priorityOrder) {
                if (wantedPieces.get(idx) && !completedPieces.get(idx) && peerHas.get(idx)) {
                    return idx;
                }
            }
            return -1;
        }

        synchronized void releasePiece(int pieceIdx) {
            inflightPieces.clear(pieceIdx);
        }

        private boolean verifyPieceHash(int pieceIdx, byte[] data) {
            byte[] digest = sha1(data);
            int pos = pieceIdx * 20;
            for (int i = 0; i < 20; i++) {
                if (digest[i] != piecesHashes[pos + i]) return false;
            }
            return true;
        }

        boolean verifyAndWritePiece(int pieceIdx, byte[] data, AtomicLong totalDownloaded, AtomicLong windowBytes) throws IOException {
            if (!verifyPieceHash(pieceIdx, data)) return false;
            synchronized (this) {
                if (completedPieces.get(pieceIdx)) return true;
                long pieceStart = (long) pieceIdx * pieceLength;
                long pieceEnd = pieceStart + data.length;
                for (TorrentFileEntry f : files) {
                    long fStart = f.offset;
                    long fEnd = fStart + f.length;
                    if (fEnd <= pieceStart || fStart >= pieceEnd || !f.selected) continue;
                    long overlapStart = Math.max(pieceStart, fStart);
                    long overlapEnd = Math.min(pieceEnd, fEnd);
                    int len = (int) (overlapEnd - overlapStart);
                    File parent = f.diskFile.getParentFile();
                    if (parent != null && !parent.exists()) {
                        //noinspection ResultOfMethodCallIgnored
                        parent.mkdirs();
                    }
                    try (RandomAccessFile raf = new RandomAccessFile(f.diskFile, "rw")) {
                        raf.seek(overlapStart - fStart);
                        raf.write(data, (int) (overlapStart - pieceStart), len);
                    }
                }
                completedPieces.set(pieceIdx);
                inflightPieces.clear(pieceIdx);
            }
            accountPieceBytes(pieceIdx, totalDownloaded, windowBytes);
            return true;
        }

        private void accountPieceBytes(int pieceIdx, AtomicLong totalDownloaded, AtomicLong windowBytes) {
            long pieceStart = (long) pieceIdx * pieceLength;
            long pieceEnd = pieceStart + pieceSize(pieceIdx);
            for (TorrentFileEntry f : files) {
                long fStart = f.offset;
                long fEnd = fStart + f.length;
                if (fEnd <= pieceStart || fStart >= pieceEnd || !f.selected) continue;
                long overlap = Math.min(pieceEnd, fEnd) - Math.max(pieceStart, fStart);
                f.downloaded.addAndGet(overlap);
                totalDownloaded.addAndGet(overlap);
                if (windowBytes != null) windowBytes.addAndGet(overlap);
            }
        }
    }

    /** Minimal, zero-dependency Bencode parser & raw `info` span locator. */
    private static final class Bencode {
        static final class Result {
            final Object value;
            final int nextIndex;

            Result(Object value, int nextIndex) {
                this.value = value;
                this.nextIndex = nextIndex;
            }
        }

        static Result decode(byte[] buf, int idx) throws IOException {
            if (idx >= buf.length) throw new EOFException("Unexpected end of bencoded data");
            byte b = buf[idx];
            if (b == 'i') {
                int end = indexOf(buf, (byte) 'e', idx + 1);
                long val = Long.parseLong(new String(buf, idx + 1, end - idx - 1, StandardCharsets.US_ASCII));
                return new Result(val, end + 1);
            } else if (b == 'l') {
                List<Object> list = new ArrayList<>();
                int cur = idx + 1;
                while (cur < buf.length && buf[cur] != 'e') {
                    Result item = decode(buf, cur);
                    list.add(item.value);
                    cur = item.nextIndex;
                }
                return new Result(list, cur + 1);
            } else if (b == 'd') {
                Map<String, Object> map = new LinkedHashMap<>();
                int cur = idx + 1;
                while (cur < buf.length && buf[cur] != 'e') {
                    Result keyRes = decode(buf, cur);
                    String key = asString(keyRes.value);
                    Result valRes = decode(buf, keyRes.nextIndex);
                    if (key != null) map.put(key, valRes.value);
                    cur = valRes.nextIndex;
                }
                return new Result(map, cur + 1);
            } else if (b >= '0' && b <= '9') {
                int colon = indexOf(buf, (byte) ':', idx);
                int len = Integer.parseInt(new String(buf, idx, colon - idx, StandardCharsets.US_ASCII));
                int start = colon + 1;
                byte[] bytes = Arrays.copyOfRange(buf, start, start + len);
                return new Result(bytes, start + len);
            }
            throw new IOException("Invalid bencode token at " + idx);
        }

        static int[] findInfoSpan(byte[] buf) throws IOException {
            if (buf.length == 0 || buf[0] != 'd') return null;
            int cur = 1;
            while (cur < buf.length && buf[cur] != 'e') {
                Result keyRes = decode(buf, cur);
                String key = asString(keyRes.value);
                int valStart = keyRes.nextIndex;
                Result valRes = decode(buf, valStart);
                if ("info".equals(key)) {
                    return new int[] { valStart, valRes.nextIndex };
                }
                cur = valRes.nextIndex;
            }
            return null;
        }

        @SuppressWarnings("unchecked")
        static Map<String, Object> asMap(Object o) {
            return o instanceof Map ? (Map<String, Object>) o : null;
        }

        static String asString(Object o) {
            if (o instanceof byte[]) return new String((byte[]) o, StandardCharsets.UTF_8);
            if (o instanceof String) return (String) o;
            return null;
        }

        private static int indexOf(byte[] buf, byte target, int from) throws IOException {
            for (int i = from; i < buf.length; i++) {
                if (buf[i] == target) return i;
            }
            throw new EOFException("Missing terminator in bencoded stream");
        }
    }

    private static byte[] httpGetBytes(String urlStr, int timeoutMs) throws IOException {
        String current = urlStr;
        for (int redirects = 0; redirects < 5; redirects++) {
            HttpURLConnection conn = (HttpURLConnection) new URL(current).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setRequestProperty("User-Agent", "Kotori/0.1.1");
            int code = conn.getResponseCode();
            if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                String loc = conn.getHeaderField("Location");
                conn.disconnect();
                if (loc == null) throw new IOException("Redirect without Location header");
                current = new URL(new URL(current), loc).toString();
                continue;
            }
            if (code < 200 || code >= 300) {
                conn.disconnect();
                throw new IOException("HTTP " + code + " from " + current);
            }
            try (InputStream in = conn.getInputStream(); ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) >= 0) {
                    bos.write(buf, 0, n);
                }
                return bos.toByteArray();
            } finally {
                conn.disconnect();
            }
        }
        throw new IOException("Too many redirects: " + urlStr);
    }

    private static List<InetSocketAddress> parseCompactPeers(byte[] buf, int offset) {
        List<InetSocketAddress> list = new ArrayList<>();
        for (int i = offset; i + 6 <= buf.length; i += 6) {
            int port = ((buf[i + 4] & 0xFF) << 8) | (buf[i + 5] & 0xFF);
            if (port <= 0) continue;
            String host = (buf[i] & 0xFF) + "." + (buf[i + 1] & 0xFF) + "." + (buf[i + 2] & 0xFF) + "." + (buf[i + 3] & 0xFF);
            list.add(InetSocketAddress.createUnresolved(host, port));
        }
        List<InetSocketAddress> resolved = new ArrayList<>(list.size());
        for (InetSocketAddress u : list) {
            resolved.add(new InetSocketAddress(u.getHostString(), u.getPort()));
        }
        return resolved;
    }

    private static void skipFully(DataInputStream in, int len) throws IOException {
        int remaining = len;
        while (remaining > 0) {
            int skipped = in.skipBytes(remaining);
            if (skipped <= 0) {
                if (in.read() < 0) throw new EOFException();
                remaining--;
            } else {
                remaining -= skipped;
            }
        }
    }

    private static byte[] sha1(byte[] input) {
        try {
            return MessageDigest.getInstance("SHA-1").digest(input);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static String urlEncodeBytes(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 3);
        for (byte b : bytes) {
            int v = b & 0xFF;
            if ((v >= 'a' && v <= 'z') || (v >= 'A' && v <= 'Z') || (v >= '0' && v <= '9') || v == '.' || v == '-' || v == '_' || v == '~') {
                sb.append((char) v);
            } else {
                sb.append(String.format(Locale.US, "%%%02X", v));
            }
        }
        return sb.toString();
    }

    private static byte[] hexToBytes(String hex) {
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    private static String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format(Locale.US, "%02x", b & 0xFF));
        }
        return sb.toString();
    }
}
