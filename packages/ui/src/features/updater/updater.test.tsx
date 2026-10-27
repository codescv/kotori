import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostProvider } from '../../host/HostContext';
import { createMockPlatformHost } from '../../host/mock-host';
import { resetStores } from '../../test/utils';
import {
  compareSemanticVersions,
  parseGithubReleaseJson,
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
