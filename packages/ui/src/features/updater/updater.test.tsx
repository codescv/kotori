import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostProvider } from '../../host/HostContext';
import { createMockPlatformHost } from '../../host/mock-host';
import { resetStores } from '../../test/utils';
import {
  compareSemanticVersions,
  handleApkInstallResumed,
  parseGithubReleaseJson,
  parseGithubReleasesAtom,
  parseSemanticVersion,
  useUpdateStore,
} from './updater';
import { UpdateBanner, UpdateSection } from './UpdateBanner';

beforeEach(resetStores);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('updater version & GitHub release parser', () => {
  it('parses and compares semantic versions', () => {
    expect(parseSemanticVersion('v0.1.11')).toEqual([0, 1, 11]);
    expect(parseSemanticVersion('1.2.3-beta.1')).toEqual([1, 2, 3]);
    expect(parseSemanticVersion('invalid')).toBeUndefined();
    expect(compareSemanticVersions('0.1.11', '0.1.10')).toBe(1);
    expect(compareSemanticVersions('v0.2.0', 'v0.1.99')).toBe(1);
    expect(compareSemanticVersions('0.1.10', '0.1.10')).toBe(0);
    expect(compareSemanticVersions('0.1.9', '0.1.10')).toBe(-1);
  });

  it('extracts release info and preferred Android APK asset from GitHub JSON', () => {
    const info = parseGithubReleaseJson({
      tag_name: 'v0.1.11',
      name: 'Kotori v0.1.11',
      body: '- Added auto update\n- Added UX enhancements',
      published_at: '2026-10-27T08:00:00Z',
      html_url: 'https://github.com/codescv/kotori/releases/tag/v0.1.11',
      assets: [
        {
          name: 'kotori-0.1.11-android.apk',
          browser_download_url: 'https://github.com/codescv/kotori/releases/download/v0.1.11/kotori-0.1.11-android.apk',
          size: 4200000,
        },
      ],
    });
    expect(info).toEqual({
      tagName: 'v0.1.11',
      version: '0.1.11',
      title: 'Kotori v0.1.11',
      notes: '- Added auto update\n- Added UX enhancements',
      publishedAt: '2026-10-27T08:00:00Z',
      htmlUrl: 'https://github.com/codescv/kotori/releases/tag/v0.1.11',
      apkUrl: 'https://github.com/codescv/kotori/releases/download/v0.1.11/kotori-0.1.11-android.apk',
      apkName: 'kotori-0.1.11-android.apk',
      apkSizeBytes: 4200000,
    });
  });

  it('parses GitHub releases.atom XML feed when REST API is rate-limited', () => {
    const atomXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Repository/1/v0.1.13</id>
    <updated>2026-10-27T10:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/codescv/kotori/releases/tag/v0.1.13"/>
    <title>Kotori v0.1.13</title>
    <content type="html">&lt;p&gt;Android UI &amp;amp; subtitle toggle&lt;/p&gt;</content>
  </entry>
</feed>`;
    const parsed = parseGithubReleasesAtom(atomXml);
    expect(parsed).toEqual({
      tagName: 'v0.1.13',
      version: '0.1.13',
      title: 'Kotori v0.1.13',
      notes: 'Android UI & subtitle toggle',
      publishedAt: '2026-10-27T10:00:00Z',
      htmlUrl: 'https://github.com/codescv/kotori/releases/tag/v0.1.13',
      apkUrl: 'https://github.com/codescv/kotori/releases/download/v0.1.13/kotori-0.1.13-android.apk',
      apkName: 'kotori-0.1.13-android.apk',
    });
  });

  it('checks for updates, renders UpdateBanner + UpdateSection, and triggers download', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    const openExternal = vi.spyOn(host.files, 'openExternal');
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: 'v9.9.9',
        name: 'Kotori v9.9.9',
        body: '- Major upgrade',
        published_at: '2026-10-27T09:00:00Z',
        html_url: 'https://github.com/codescv/kotori/releases/tag/v9.9.9',
        assets: [
          {
            name: 'kotori-9.9.9-android.apk',
            browser_download_url: 'https://github.com/codescv/kotori/releases/download/v9.9.9/kotori-9.9.9-android.apk',
            size: 5120000,
          },
        ],
      }),
    }) as unknown as typeof fetch;

    await useUpdateStore.getState().checkForUpdate(host, { silent: true, fetchImpl: fakeFetch });
    expect(useUpdateStore.getState().status).toBe('available');
    expect(useUpdateStore.getState().release?.version).toBe('9.9.9');

    render(
      <HostProvider host={host}>
        <UpdateBanner />
        <UpdateSection />
      </HostProvider>,
    );

    expect(screen.getByTestId('update-banner')).toHaveTextContent('发现新版本 v9.9.9');
    expect(screen.getByTestId('settings-update-section')).toHaveTextContent('发现新版本 v9.9.9');

    fireEvent.click(screen.getByTestId('update-banner-download'));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://github.com/codescv/kotori/releases/tag/v9.9.9'));

    fireEvent.click(screen.getByTestId('update-banner-dismiss'));
    expect(screen.queryByTestId('update-banner')).toBeNull();
    await host.dispose();
  });
});

describe('v0.1.34 Android direct update install (single tap)', () => {
  type Listener = (ev: Record<string, unknown>) => void;

  function installNativePlugin(downloadResult: { installed: boolean; needsPermission?: boolean }) {
    const listeners = new Map<string, Listener[]>();
    const plugin = {
      downloadAndInstallApk: vi.fn(async () => {
        for (const l of listeners.get('apkDownloadProgress') ?? []) {
          l({ downloadedBytes: 2560000, totalBytes: 5120000, percent: 50 });
        }
        return { filePath: '/cache/updates/kotori-9.9.9.apk', sizeBytes: 5120000, ...downloadResult };
      }),
      installApkFile: vi.fn(async () => ({ installed: true, needsPermission: false })),
      addListener: vi.fn(async (name: string, listener: Listener) => {
        listeners.set(name, [...(listeners.get(name) ?? []), listener]);
        return {
          remove: async () => {
            listeners.set(
              name,
              (listeners.get(name) ?? []).filter((l) => l !== listener),
            );
          },
        };
      }),
    };
    (globalThis as Record<string, unknown>).Capacitor = {
      isNativePlatform: () => true,
      Plugins: { KotoriTorrent: plugin },
    };
    const emit = (name: string, ev: Record<string, unknown>) => {
      for (const l of listeners.get(name) ?? []) l(ev);
    };
    return { plugin, emit, listeners };
  }

  function seedAvailableRelease() {
    useUpdateStore.setState({
      status: 'available',
      currentVersion: '0.1.33',
      release: {
        tagName: 'v9.9.9',
        version: '9.9.9',
        title: 'Kotori v9.9.9',
        notes: '- Direct install',
        publishedAt: '2026-11-02T00:00:00Z',
        htmlUrl: 'https://github.com/codescv/kotori/releases/tag/v9.9.9',
        apkUrl: 'https://github.com/codescv/kotori/releases/download/v9.9.9/kotori-9.9.9-android.apk',
        apkName: 'kotori-9.9.9-android.apk',
        apkSizeBytes: 5120000,
      },
    });
  }

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).Capacitor;
  });

  it('one tap on 下载并安装 downloads and launches the installer without a second click', async () => {
    const { plugin } = installNativePlugin({ installed: true, needsPermission: false });
    const host = createMockPlatformHost({ latencyMs: 0 });
    const openExternal = vi.spyOn(host.files, 'openExternal');
    seedAvailableRelease();
    render(
      <HostProvider host={host}>
        <UpdateSection />
      </HostProvider>,
    );

    fireEvent.click(screen.getByTestId('download-update-btn'));
    await waitFor(() => expect(useUpdateStore.getState().status).toBe('ready-to-install'));

    expect(plugin.downloadAndInstallApk).toHaveBeenCalledTimes(1);
    expect(plugin.downloadAndInstallApk).toHaveBeenCalledWith({
      url: 'https://github.com/codescv/kotori/releases/download/v9.9.9/kotori-9.9.9-android.apk',
      version: '9.9.9',
    });
    // Installer is launched natively inside downloadAndInstallApk: no second native call needed.
    expect(plugin.installApkFile).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().needsPermission).toBe(false);
    expect(screen.getByTestId('update-status-text')).toHaveTextContent('已调起系统安装器');

    // Re-trigger button stays available in case the user dismissed the system installer.
    fireEvent.click(screen.getByTestId('install-update-btn'));
    await waitFor(() =>
      expect(plugin.installApkFile).toHaveBeenCalledWith({ filePath: '/cache/updates/kotori-9.9.9.apk' }),
    );
    await host.dispose();
  });

  it('missing unknown-sources permission auto-resumes install via apkInstallResumed', async () => {
    const { plugin, emit } = installNativePlugin({ installed: false, needsPermission: true });
    const host = createMockPlatformHost({ latencyMs: 0 });
    seedAvailableRelease();
    render(
      <HostProvider host={host}>
        <UpdateBanner />
        <UpdateSection />
      </HostProvider>,
    );

    fireEvent.click(screen.getByTestId('update-banner-download'));
    await waitFor(() => expect(useUpdateStore.getState().needsPermission).toBe(true));
    expect(screen.getByTestId('update-status-text')).toHaveTextContent('返回后将自动安装');
    expect(plugin.addListener).toHaveBeenCalledWith('apkInstallResumed', expect.any(Function));

    // Native handleOnResume() launched the installer after the permission was granted.
    act(() => emit('apkInstallResumed', { filePath: '/cache/updates/kotori-9.9.9.apk', installed: true }));
    expect(useUpdateStore.getState().needsPermission).toBe(false);
    expect(useUpdateStore.getState().status).toBe('ready-to-install');
    expect(plugin.installApkFile).not.toHaveBeenCalled();
    expect(screen.getByTestId('update-banner-install')).toHaveTextContent('安装更新');
    await host.dispose();
  });

  it('handleApkInstallResumed surfaces installer launch failures', () => {
    seedAvailableRelease();
    useUpdateStore.setState({ status: 'ready-to-install', needsPermission: true });
    handleApkInstallResumed({ installed: false, error: 'boom' });
    expect(useUpdateStore.getState().needsPermission).toBe(false);
    expect(useUpdateStore.getState().status).toBe('ready-to-install');
  });
});
