/**
 * Cross-platform in-app update checker and downloader/installer.
 *
 * - Queries GitHub Releases (`https://api.github.com/repos/codescv/kotori/releases/latest`
 *   with fallback to `/releases?per_page=5`).
 * - Compares semantic versions (`vX.Y.Z`) against `host.info.version`.
 * - On Android (`window.Capacitor?.Plugins?.KotoriTorrent?.downloadAndInstallApk`),
 *   streams the release APK to cache with live progress (`apkDownloadProgress`)
 *   and launches the Android package installer via `FileProvider`.
 * - On Desktop / Web, opens the release asset / page via `host.files.openExternal`.
 */
import { create } from 'zustand';
import type { PlatformHost } from '@kotori/core';
import { showSnackbar } from '../../stores/snackbar';

export const GITHUB_RELEASE_API_URL = 'https://api.github.com/repos/codescv/kotori/releases/latest';
export const GITHUB_RELEASES_LIST_URL = 'https://api.github.com/repos/codescv/kotori/releases?per_page=5';
export const GITHUB_RELEASES_HTML_URL = 'https://github.com/codescv/kotori/releases';

export interface ReleaseInfo {
  readonly tagName: string;
  readonly version: string;
  readonly title: string;
  readonly notes: string;
  readonly publishedAt: string;
  readonly htmlUrl: string;
  readonly apkUrl?: string;
  readonly apkName?: string;
  readonly apkSizeBytes?: number;
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready-to-install'
  | 'error';

export interface UpdateState {
  readonly status: UpdateStatus;
  readonly currentVersion: string;
  readonly release?: ReleaseInfo | undefined;
  readonly progressPercent: number;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
  readonly downloadedFilePath?: string | undefined;
  readonly needsPermission?: boolean | undefined;
  readonly error?: string | undefined;
  readonly dismissedTag?: string | undefined;
  readonly lastCheckedAt?: number | undefined;
  checkForUpdate(
    host: PlatformHost,
    options?: { readonly silent?: boolean; readonly fetchImpl?: typeof fetch },
  ): Promise<ReleaseInfo | undefined>;
  downloadUpdate(host: PlatformHost): Promise<void>;
  installDownloadedApk(host: PlatformHost): Promise<void>;
  dismiss(tagName?: string): void;
  reset(): void;
}

interface NativeUpdaterPlugin {
  downloadAndInstallApk?(options: {
    url: string;
    version: string;
  }): Promise<{
    filePath: string;
    sizeBytes: number;
    installed: boolean;
    needsPermission?: boolean;
  }>;
  installApkFile?(options: {
    filePath: string;
  }): Promise<{
    installed: boolean;
    needsPermission?: boolean;
  }>;
  addListener?(
    eventName: 'apkDownloadProgress',
    listener: (event: { downloadedBytes: number; totalBytes: number; percent: number }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

function getNativeUpdaterPlugin(): NativeUpdaterPlugin | undefined {
  const g = globalThis as {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      Plugins?: { KotoriTorrent?: NativeUpdaterPlugin };
    };
  };
  if (!g.Capacitor?.isNativePlatform?.()) return undefined;
  const plugin = g.Capacitor.Plugins?.KotoriTorrent;
  return plugin && typeof plugin.downloadAndInstallApk === 'function' ? plugin : undefined;
}

/** Parse a `vX.Y.Z` or `X.Y.Z` tag into numeric `[major, minor, patch]`. */
export function parseSemanticVersion(raw: string): readonly [number, number, number] | undefined {
  const cleaned = raw.trim().replace(/^[vV]/, '');
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(cleaned);
  if (!m) return undefined;
  const major = Number.parseInt(m[1] ?? '0', 10);
  const minor = Number.parseInt(m[2] ?? '0', 10);
  const patch = Number.parseInt(m[3] ?? '0', 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return undefined;
  return [major, minor, patch];
}

/**
 * Compare two semantic version strings (`a` vs `b`).
 * Returns `1` if `a > b`, `-1` if `a < b`, `0` if equal or unparseable.
 */
export function compareSemanticVersions(a: string, b: string): -1 | 0 | 1 {
  const va = parseSemanticVersion(a);
  const vb = parseSemanticVersion(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i++) {
    const da = va[i] ?? 0;
    const db = vb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

interface GithubAssetJson {
  readonly name?: unknown;
  readonly browser_download_url?: unknown;
  readonly size?: unknown;
}

interface GithubReleaseJson {
  readonly tag_name?: unknown;
  readonly name?: unknown;
  readonly body?: unknown;
  readonly published_at?: unknown;
  readonly html_url?: unknown;
  readonly draft?: unknown;
  readonly prerelease?: unknown;
  readonly assets?: unknown;
}

/** Parse a GitHub Release JSON object (or array of releases) into `ReleaseInfo`. */
export function parseGithubReleaseJson(data: unknown): ReleaseInfo | undefined {
  if (Array.isArray(data)) {
    for (const item of data) {
      const parsed = parseGithubReleaseJson(item);
      if (parsed) return parsed;
    }
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const rel = data as GithubReleaseJson;
  if (rel.draft === true) return undefined;
  const tagName = typeof rel.tag_name === 'string' ? rel.tag_name.trim() : '';
  const semver = parseSemanticVersion(tagName);
  if (!tagName || !semver) return undefined;
  const version = `${semver[0]}.${semver[1]}.${semver[2]}`;
  const title = typeof rel.name === 'string' && rel.name.trim() !== '' ? rel.name.trim() : tagName;
  const notes = typeof rel.body === 'string' ? rel.body.trim() : '';
  const publishedAt = typeof rel.published_at === 'string' ? rel.published_at : '';
  const htmlUrl =
    typeof rel.html_url === 'string' && rel.html_url.trim() !== ''
      ? rel.html_url.trim()
      : `${GITHUB_RELEASES_HTML_URL}/tag/${tagName}`;

  let apkUrl: string | undefined;
  let apkName: string | undefined;
  let apkSizeBytes: number | undefined;

  if (Array.isArray(rel.assets)) {
    const assets = rel.assets as GithubAssetJson[];
    const apkAssets = assets.filter(
      (a) =>
        typeof a?.name === 'string' &&
        a.name.toLowerCase().endsWith('.apk') &&
        typeof a?.browser_download_url === 'string',
    );
    const preferred =
      apkAssets.find((a) => String(a.name).toLowerCase().includes('android')) ?? apkAssets[0];
    if (preferred && typeof preferred.browser_download_url === 'string') {
      apkUrl = preferred.browser_download_url;
      apkName = typeof preferred.name === 'string' ? preferred.name : undefined;
      apkSizeBytes = typeof preferred.size === 'number' && preferred.size > 0 ? preferred.size : undefined;
    }
  }

  return {
    tagName,
    version,
    title,
    notes,
    publishedAt,
    htmlUrl,
    ...(apkUrl ? { apkUrl } : {}),
    ...(apkName ? { apkName } : {}),
    ...(apkSizeBytes !== undefined ? { apkSizeBytes } : {}),
  };
}

async function fetchLatestRelease(fetchImpl: typeof fetch): Promise<ReleaseInfo> {
  const headers = { Accept: 'application/vnd.github+json' };
  const res = await fetchImpl(GITHUB_RELEASE_API_URL, { headers });
  if (res.ok) {
    const info = parseGithubReleaseJson(await res.json());
    if (info) return info;
  }
  const listRes = await fetchImpl(GITHUB_RELEASES_LIST_URL, { headers });
  if (!listRes.ok) {
    throw new Error(`HTTP ${listRes.status}`);
  }
  const info = parseGithubReleaseJson(await listRes.json());
  if (!info) {
    throw new Error('未找到有效的版本发布记录');
  }
  return info;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: 'idle',
  currentVersion: '0.1.12',
  progressPercent: 0,
  downloadedBytes: 0,
  totalBytes: 0,

  async checkForUpdate(host, options) {
    const silent = options?.silent ?? false;
    const fetchImpl = options?.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    const currentVersion = host.info.version;
    set({ status: 'checking', currentVersion, error: undefined });
    try {
      if (typeof fetchImpl !== 'function') {
        throw new Error('当前环境不支持网络请求');
      }
      const release = await fetchLatestRelease(fetchImpl);
      const cmp = compareSemanticVersions(release.version, currentVersion);
      if (cmp > 0) {
        set({
          status: 'available',
          currentVersion,
          release,
          lastCheckedAt: Date.now(),
          error: undefined,
        });
        if (!silent) {
          showSnackbar(`发现新版本 v${release.version}`, { tone: 'info' });
        }
      } else {
        set({
          status: 'up-to-date',
          currentVersion,
          release,
          lastCheckedAt: Date.now(),
          error: undefined,
        });
        if (!silent) {
          showSnackbar(`当前已是最新版本 (v${currentVersion})`, { tone: 'info' });
        }
      }
      return release;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({
        status: 'error',
        currentVersion,
        error: msg,
        lastCheckedAt: Date.now(),
      });
      if (!silent) {
        showSnackbar(`检查更新失败：${msg}`, { tone: 'error' });
      }
      return undefined;
    }
  },

  async downloadUpdate(host) {
    const { release } = get();
    if (!release) return;
    const nativePlugin = getNativeUpdaterPlugin();
    if (nativePlugin?.downloadAndInstallApk && release.apkUrl) {
      set({
        status: 'downloading',
        progressPercent: 0,
        downloadedBytes: 0,
        totalBytes: release.apkSizeBytes ?? 0,
        error: undefined,
        needsPermission: false,
      });
      let listenerHandle: { remove: () => Promise<void> } | undefined;
      try {
        if (nativePlugin.addListener) {
          listenerHandle = await nativePlugin.addListener('apkDownloadProgress', (ev) => {
            set({
              downloadedBytes: ev.downloadedBytes,
              totalBytes: ev.totalBytes > 0 ? ev.totalBytes : (release.apkSizeBytes ?? 0),
              progressPercent: ev.percent >= 0 ? ev.percent : 0,
            });
          });
        }
        const res = await nativePlugin.downloadAndInstallApk({
          url: release.apkUrl,
          version: release.version,
        });
        set({
          status: 'ready-to-install',
          progressPercent: 100,
          downloadedFilePath: res.filePath,
          needsPermission: Boolean(res.needsPermission),
        });
        if (res.needsPermission) {
          showSnackbar('请授予「安装未知应用」权限后点击「安装更新」', { tone: 'info' });
        } else {
          showSnackbar(`v${release.version} 下载完成，正在调起系统安装器…`, { tone: 'info' });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        set({ status: 'error', error: msg });
        showSnackbar(`更新包下载失败：${msg}`, { tone: 'error' });
      } finally {
        if (listenerHandle) {
          await listenerHandle.remove().catch(() => undefined);
        }
      }
      return;
    }

    // Desktop / Web or Android fallback: open APK direct URL or release page via host.files.openExternal
    const targetUrl =
      host.info.os === 'android' && release.apkUrl ? release.apkUrl : release.htmlUrl || GITHUB_RELEASES_HTML_URL;
    try {
      if (host.files.openExternal) {
        await host.files.openExternal(targetUrl);
      } else if (typeof window !== 'undefined') {
        window.open(targetUrl, '_blank', 'noopener');
      }
      showSnackbar(`已打开 v${release.version} 下载页面`, { tone: 'info' });
    } catch (e) {
      showSnackbar(e instanceof Error ? e.message : String(e), { tone: 'error' });
    }
  },

  async installDownloadedApk(host) {
    const { downloadedFilePath, release } = get();
    const nativePlugin = getNativeUpdaterPlugin();
    if (nativePlugin?.installApkFile && downloadedFilePath) {
      try {
        const res = await nativePlugin.installApkFile({ filePath: downloadedFilePath });
        set({ needsPermission: Boolean(res.needsPermission) });
        if (res.needsPermission) {
          showSnackbar('请先在系统设置中允许安装未知应用', { tone: 'info' });
        }
        return;
      } catch (e) {
        showSnackbar(e instanceof Error ? e.message : String(e), { tone: 'error' });
      }
    }
    if (release) {
      await get().downloadUpdate(host);
    }
  },

  dismiss(tagName) {
    const tag = tagName ?? get().release?.tagName;
    set({ dismissedTag: tag });
  },

  reset() {
    set({
      status: 'idle',
      release: undefined,
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      downloadedFilePath: undefined,
      needsPermission: undefined,
      error: undefined,
      dismissedTag: undefined,
    });
  },
}));
