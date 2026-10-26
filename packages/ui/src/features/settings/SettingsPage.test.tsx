import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HostProvider } from '../../host/HostContext';
import { createMockPlatformHost, type MockPlatformHost } from '../../host/mock-host';
import { useSettingsStore } from '../../stores/settings';
import { SettingsPage } from './SettingsPage';

async function setup(): Promise<MockPlatformHost> {
  const host = createMockPlatformHost({ latencyMs: 0 });
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
  it('renders every section and the about line', async () => {
    await setup();
    for (const id of ['settings-ai', 'settings-appearance', 'settings-anime', 'settings-manga', 'settings-downloads', 'settings-library', 'settings-about']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(screen.getByTestId('settings-about-platform')).toHaveTextContent('mock · linux · v0.1.0-mock');
  });

  it('appearance changes apply immediately (theme, seed preset, locale)', async () => {
    const host = await setup();
    const appearance = within(screen.getByTestId('settings-appearance'));
    fireEvent.click(appearance.getByRole('radio', { name: '深色' }));
    fireEvent.click(appearance.getByRole('radio', { name: '#7d8fc9' }));
    await waitFor(async () => {
      const ui = (await host.settings.get()).ui;
      expect(ui.theme).toBe('dark');
      expect(ui.seedColor).toBe('#7d8fc9');
    });
    expect(useSettingsStore.getState().settings.ui.seedColor).toBe('#7d8fc9');
    fireEvent.change(appearance.getByLabelText('自定义 HEX 颜色'), { target: { value: 'zzz' } });
    expect(appearance.getByText('请输入 #RRGGBB 格式')).toBeInTheDocument();
  });

  it('anime switches and numeric fields commit to the host', async () => {
    const host = await setup();
    const anime = within(screen.getByTestId('settings-anime'));
    fireEvent.click(anime.getByRole('switch', { name: '隐藏特效/标牌字幕' }));
    const repeat = anime.getByLabelText('单句循环次数（0 = 无限）');
    fireEvent.change(repeat, { target: { value: '5' } });
    fireEvent.blur(repeat);
    await waitFor(async () => {
      const a = (await host.settings.get()).anime;
      expect(a.hideSigns).toBe(false);
      expect(a.repeatCount).toBe(5);
    });
  });

  it('library: add a folder through the path browser and remove it', async () => {
    const host = await setup();
    const lib = within(screen.getByTestId('roots-animeRoots'));
    fireEvent.click(lib.getByRole('button', { name: '添加文件夹' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: /Anime/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: '确定' }));
    await waitFor(async () => expect((await host.settings.get()).library.animeRoots).toEqual(['/home/kotori/Anime']));
    fireEvent.click(await within(screen.getByTestId('roots-animeRoots')).findByRole('button', { name: '删除' }));
    await waitFor(async () => expect((await host.settings.get()).library.animeRoots).toEqual([]));
  });
});
