import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HostProvider } from '../../host/HostContext';
import { createMockPlatformHost, type MockPlatformHost } from '../../host/mock-host';
import { useSettingsStore } from '../../stores/settings';
import { SettingsPage } from './SettingsPage';

const baseCss = readFileSync(resolve(import.meta.dirname, '../../theme/styles.css'), 'utf8');
const settingsCss = readFileSync(resolve(import.meta.dirname, './settings.css'), 'utf8');

async function setup(opts: Parameters<typeof createMockPlatformHost>[0] = {}): Promise<MockPlatformHost> {
  const host = createMockPlatformHost({ latencyMs: 0, ...opts });
  await useSettingsStore.getState().load(host);
  render(
    <HostProvider host={host}>
      <SettingsPage />
    </HostProvider>,
  );
  return host;
}

beforeEach(() => useSettingsStore.getState().reset());
afterEach(() => cleanup());

describe('SettingsPage', () => {
  it('renders the 5 simplified cards and full-width about footer', async () => {
    await setup();
    for (const id of ['settings-ai', 'settings-dictionary', 'settings-learning', 'settings-appearance', 'settings-media', 'settings-about']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    for (const removedId of ['settings-anime', 'settings-manga', 'settings-downloads', 'settings-library']) {
      expect(screen.queryByTestId(removedId)).toBeNull();
    }
    const about = screen.getByTestId('settings-about');
    expect(about.tagName).toBe('FOOTER');
    expect(screen.getByTestId('settings-about-origin')).toBeInTheDocument();
    expect(screen.getByTestId('settings-about-platform')).toHaveTextContent('mock · linux · v0.1.0-mock');
    expect(within(about).getByTestId('settings-update-section')).toBeInTheDocument();
  });

  it('appearance changes apply immediately (theme, compact app icon grid, seed preset, locale, font preview)', async () => {
    const host = await setup();
    const appearance = within(screen.getByTestId('settings-appearance'));
    for (const id of ['s4-01', 's4-02', 's4-03', 's4-04', 's3-01', 's3-02', 's3-03', 's3-04']) {
      const btn = appearance.getByTestId(`app-icon-${id}`);
      expect(btn).toBeInTheDocument();
      expect(btn.querySelector('.k-app-icon-option__code')).toBeNull();
    }
    expect(appearance.queryByLabelText('自定义 HEX 颜色')).toBeNull();
    expect(appearance.getByText(/べてんじゃねぇよ/)).toBeInTheDocument();

    expect(appearance.getByTestId('app-icon-s4-01')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(appearance.getByTestId('app-icon-s3-02'));
    fireEvent.click(appearance.getByRole('radio', { name: '深色' }));
    fireEvent.click(appearance.getByRole('radio', { name: '#7d8fc9' }));
    await waitFor(async () => {
      const ui = (await host.settings.get()).ui;
      expect(ui.theme).toBe('dark');
      expect(ui.seedColor).toBe('#7d8fc9');
      expect(ui.appIcon).toBe('s3-02');
    });
    expect(appearance.getByTestId('app-icon-s3-02')).toHaveAttribute('aria-checked', 'true');
    expect(useSettingsStore.getState().settings.ui.seedColor).toBe('#7d8fc9');
    expect(useSettingsStore.getState().settings.ui.appIcon).toBe('s3-02');
  });

  it('learning & reading section commits furigana, romaji, pre-explain and manga display defaults', async () => {
    const host = await setup();
    const learning = within(screen.getByTestId('settings-learning'));

    // Removed noisy playback/reader knobs are absent.
    expect(learning.queryByRole('switch', { name: '隐藏特效/标牌字幕' })).toBeNull();
    expect(learning.queryByLabelText('单句循环次数（0 = 无限）')).toBeNull();
    expect(learning.queryByRole('switch', { name: '显示 OCR 气泡框' })).toBeNull();

    expect(learning.getByRole('radio', { name: '全部显示' })).toHaveAttribute('aria-checked', 'true');
    expect(learning.getByRole('switch', { name: '显示罗马音' })).toHaveAttribute('aria-checked', 'false');
    expect(learning.getByRole('switch', { name: '视频字幕后台预解析' })).toHaveAttribute('aria-checked', 'false');
    expect(learning.getByRole('switch', { name: '漫画气泡后台预解析' })).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(learning.getByRole('radio', { name: '点按揭示' }));
    fireEvent.click(learning.getByRole('switch', { name: '显示罗马音' }));
    fireEvent.click(learning.getByRole('switch', { name: '视频字幕后台预解析' }));
    fireEvent.click(learning.getByRole('switch', { name: '漫画气泡后台预解析' }));
    fireEvent.click(learning.getByRole('radio', { name: '单页（右→左）' }));
    fireEvent.click(learning.getByRole('radio', { name: '适应宽度' }));
    fireEvent.click(learning.getByRole('radio', { name: '黑色' }));

    await waitFor(async () => {
      const s = await host.settings.get();
      expect(s.anime.furiganaMode).toBe('tap');
      expect(s.anime.showRomaji).toBe(true);
      expect(s.anime.autoPreExplain).toBe(true);
      expect(s.manga.autoPreExplain).toBe(true);
      expect(s.manga.defaultReadingMode).toBe('single-rtl');
      expect(s.manga.fit).toBe('width');
      expect(s.manga.background).toBe('black');
    });
    expect(learning.getByRole('radio', { name: '点按揭示' })).toHaveAttribute('aria-checked', 'true');
  });

  it('media section manages library folders, download settings, and gates Nyaa mirror by torrent capability', async () => {
    const host = await setup();
    const media = within(screen.getByTestId('settings-media'));

    expect(media.queryByLabelText('同时下载数')).toBeNull();
    expect(media.queryByLabelText('每个种子最大连接数')).toBeNull();

    const adv = screen.getByTestId('media-advanced-disclosure') as HTMLDetailsElement;
    expect(adv.open).toBe(false);
    expect(media.getByLabelText('Nyaa 镜像地址')).toBeInTheDocument();
    expect(media.getByLabelText('mokuro.moe 目录地址')).toBeInTheDocument();

    const lib = within(screen.getByTestId('roots-animeRoots'));
    fireEvent.click(lib.getByRole('button', { name: '添加文件夹' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: /Anime/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: '确定' }));
    await waitFor(async () => expect((await host.settings.get()).library.animeRoots).toEqual(['/home/kotori/Anime']));
    fireEvent.click(await within(screen.getByTestId('roots-animeRoots')).findByRole('button', { name: '删除' }));
    await waitFor(async () => expect((await host.settings.get()).library.animeRoots).toEqual([]));

    cleanup();
    useSettingsStore.getState().reset();
    await setup({ capabilities: { torrent: false } });
    const mobileMedia = within(screen.getByTestId('settings-media'));
    expect(mobileMedia.queryByLabelText('Nyaa 镜像地址')).toBeNull();
    expect(mobileMedia.getByLabelText('mokuro.moe 目录地址')).toBeInTheDocument();
  });

  it('keeps segmented controls and standalone settings buttons fit-content instead of stretching full row', async () => {
    expect(baseCss).toMatch(/\.k-segmented\s*\{[^}]*width:\s*fit-content;[^}]*align-self:\s*flex-start;[^}]*max-width:\s*100%;/s);
    expect(settingsCss).toMatch(/\.k-settings-section__body\s*>\s*\.k-btn[\s\S]*?\.k-settings-field\s*>\s*\.k-btn[\s\S]*?\.k-settings-disclosure__body\s*>\s*\.k-btn[\s\S]*?\.k-dict-settings\s*>\s*\.k-btn[\s\S]*?\{[\s\S]*?align-self:\s*flex-start;\s*width:\s*fit-content;/);
    expect(settingsCss).toMatch(/@media\s*\(max-width:\s*600px\)\s*\{[\s\S]*?\.k-dict-manage__toolbar-btns\s+\.k-btn\s*\{[^}]*width:\s*100%;/);
    expect(settingsCss).toMatch(/\.k-ai-form__auth-kinds\s*\{[^}]*flex-wrap:\s*wrap;[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;/s);

    const { container } = render(
      <HostProvider host={createMockPlatformHost({ latencyMs: 0 })}>
        <SettingsPage />
      </HostProvider>,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Vertex AI' }));
    const segmentedControls = Array.from(container.querySelectorAll<HTMLElement>('.k-segmented'));
    expect(segmentedControls.length).toBeGreaterThanOrEqual(8);
    expect(container.querySelector('.k-ai-form__auth-kinds')).toHaveClass('k-segmented');

    const clearCacheBtn = screen.getByTestId('ai-clear-cache-btn');
    expect(clearCacheBtn).toHaveClass('k-btn');
    expect(clearCacheBtn.parentElement).toHaveClass('k-settings-disclosure__body');

    const dictManageBtn = screen.getByTestId('dict-manage-btn');
    expect(dictManageBtn).toHaveClass('k-btn');
    expect(dictManageBtn.parentElement).toHaveClass('k-row');
  });
});
