import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { RECOMMENDED_DICT_PRESETS } from '@kotori/core';
import { dispatchBackNavigation } from '../../../app/routes';
import { HostProvider } from '../../../host/HostContext';
import { createMockPlatformHost, type MockHostOptions, type MockPlatformHost } from '../../../host/mock-host';
import { useDictStore } from '../../../stores/dict';
import { resetStores } from '../../../test/utils';
import { DictionarySection } from './DictionarySection';

async function setup(options: MockHostOptions = {}, openModal = false): Promise<MockPlatformHost> {
  const host = createMockPlatformHost({ latencyMs: 0, ...options });
  render(
    <HostProvider host={host}>
      <DictionarySection />
    </HostProvider>,
  );
  await waitFor(() => expect(useDictStore.getState().loaded).toBe(true));
  if (openModal) {
    fireEvent.click(screen.getByTestId('dict-manage-btn'));
    expect(screen.getByTestId('dict-manage-dialog')).toBeInTheDocument();
  }
  return host;
}

const rowIds = (): string[] => within(screen.getByTestId('dict-installed-list')).getAllByRole('listitem').map((li) => li.getAttribute('data-testid') ?? '');

describe('DictionarySection (Settings → 词典与查词)', () => {
  beforeEach(resetStores);

  it('renders a simplified card with summary + 管理词典 button only until opened', async () => {
    await setup();
    const card = screen.getByTestId('settings-dictionary-section');
    expect(card).toBeInTheDocument();
    expect(screen.getByTestId('dict-summary').textContent).toContain('已安装 3 本词典（已启用 3 本）');
    expect(screen.getByTestId('dict-manage-btn').textContent).toContain('管理词典');
    expect(screen.queryByTestId('dict-manage-dialog')).toBeNull();
    expect(screen.queryByTestId('dict-installed-list')).toBeNull();
    expect(screen.queryByTestId('dict-presets')).toBeNull();
    expect(screen.queryByTestId('dict-import-zip-btn')).toBeNull();
    expect(screen.queryByTestId('dict-install-all-presets-btn')).toBeNull();

    // Opening the dialog reveals management & download controls, and Android back closes it.
    fireEvent.click(screen.getByTestId('dict-manage-btn'));
    expect(screen.getByTestId('dict-manage-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('dict-install-all-presets-btn')).toBeInTheDocument();
    expect(screen.getByTestId('dict-import-zip-btn')).toBeInTheDocument();
    act(() => {
      expect(dispatchBackNavigation()).toBe(true);
    });
    expect(screen.queryByTestId('dict-manage-dialog')).toBeNull();
  });

  it('shows empty-state summary on the simplified card when zero dictionaries are installed', async () => {
    await setup({ dictionaries: 'empty' });
    expect(screen.getByTestId('dict-summary').textContent).toContain('尚未安装本地词典');
    expect(screen.queryByTestId('dict-installed-empty')).toBeNull();
    fireEvent.click(screen.getByTestId('dict-manage-btn'));
    expect(screen.getByTestId('dict-installed-empty')).toBeInTheDocument();
    expect(screen.getByTestId('dict-install-all-presets-btn').textContent).toBe('一键下载全部推荐词典');
    fireEvent.click(screen.getByTestId('dict-manage-close-btn'));
    expect(screen.queryByTestId('dict-manage-dialog')).toBeNull();
  });

  it('lists installed dictionaries with kind badge, revision, counts and attribution inside the dialog', async () => {
    await setup({}, true);
    expect(rowIds()).toEqual(['dict-row-wty-ja-zh', 'dict-row-kanjium-pitch', 'dict-row-jpdb-freq']);
    expect(screen.getByTestId('dict-kind-wty-ja-zh').textContent).toBe('释义');
    expect(screen.getByTestId('dict-kind-kanjium-pitch').textContent).toBe('音高');
    expect(screen.getByTestId('dict-kind-jpdb-freq').textContent).toBe('词频');
    const wty = screen.getByTestId('dict-row-wty-ja-zh');
    expect(wty.textContent).toContain('版本 2026.10.22');
    expect(wty.textContent).toContain('187,449 词条');
    expect(wty.textContent).toContain('Wiktionary / Kaikki.org');
    expect(screen.getByTestId('dict-up-wty-ja-zh')).toBeDisabled();
    expect(screen.getByTestId('dict-down-jpdb-freq')).toBeDisabled();
  });

  it('shows every recommended preset with size, licence badge and verbatim attribution', async () => {
    await setup({}, true);
    for (const p of RECOMMENDED_DICT_PRESETS) {
      const row = screen.getByTestId(`dict-preset-${p.id}`);
      expect(row.textContent).toContain(p.sizeLabel);
      expect(screen.getByTestId(`dict-license-${p.id}`).textContent).toBe(p.license);
      expect(screen.getByTestId(`dict-attribution-${p.id}`).textContent).toContain(p.attribution);
    }
    expect(screen.getByTestId('dict-license-wty-ja-zh').textContent).toBe('CC BY-SA 4.0');
    expect(screen.getByTestId('dict-preset-install-jitendex').textContent).toBe('一键下载并导入');
    // externalOnly (JPDB): external guide + one-click import; already installed here ⇒ re-download.
    expect(screen.getByTestId('dict-preset-guide-jpdb-freq')).toBeInTheDocument();
    expect(screen.queryByTestId('dict-preset-guide-wty-ja-zh')).toBeNull();
  });

  it('one-click install all presets downloads only missing presets, or all when zero installed', async () => {
    // 1. Seeded state has 3 presets installed → downloads the 2 remaining presets.
    const host = await setup({}, true);
    const btn = screen.getByTestId('dict-install-all-presets-btn');
    expect(btn.textContent).toContain('一键下载全部推荐词典');
    expect(btn.textContent).toContain('2');
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(rowIds()).toHaveLength(RECOMMENDED_DICT_PRESETS.length));
    expect(host.calls.get('dict.importZip')).toBe(2);
    for (const p of RECOMMENDED_DICT_PRESETS) {
      expect(screen.getByTestId(`dict-row-${p.id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('dict-install-all-presets-btn').textContent).toContain('全部推荐词典已安装');
    expect(screen.getByTestId('dict-summary').textContent).toContain(`已安装 ${RECOMMENDED_DICT_PRESETS.length} 本词典`);
  });

  it('one-click install all presets from empty state installs all 5 recommended dictionaries', async () => {
    const host = await setup({ dictionaries: 'empty' }, true);
    expect(screen.getByTestId('dict-install-all-presets-btn').textContent).toBe('一键下载全部推荐词典');
    await act(async () => {
      fireEvent.click(screen.getByTestId('dict-install-all-presets-btn'));
    });
    await waitFor(() => expect(rowIds()).toHaveLength(RECOMMENDED_DICT_PRESETS.length));
    expect(host.calls.get('dict.importZip')).toBe(RECOMMENDED_DICT_PRESETS.length);
  });

  it('enable switch, priority ↑/↓ and two-step delete update host + dictSetRevision', async () => {
    const host = await setup({}, true);
    const rev0 = useDictStore.getState().dictSetRevision;

    fireEvent.click(within(screen.getByTestId('dict-row-kanjium-pitch')).getByRole('switch'));
    await waitFor(() => expect(within(screen.getByTestId('dict-row-kanjium-pitch')).getByRole('switch')).toHaveAttribute('aria-checked', 'false'));
    expect((await host.dict!.list()).find((d) => d.id === 'kanjium-pitch')?.enabled).toBe(false);
    expect(useDictStore.getState().dictSetRevision).toBeGreaterThan(rev0);

    fireEvent.click(screen.getByTestId('dict-down-wty-ja-zh'));
    await waitFor(() => expect(rowIds()).toEqual(['dict-row-kanjium-pitch', 'dict-row-wty-ja-zh', 'dict-row-jpdb-freq']));
    expect((await host.dict!.list()).map((d) => d.id)).toEqual(['kanjium-pitch', 'wty-ja-zh', 'jpdb-freq']);
    fireEvent.click(screen.getByTestId('dict-up-jpdb-freq'));
    await waitFor(() => expect(rowIds()).toEqual(['dict-row-kanjium-pitch', 'dict-row-jpdb-freq', 'dict-row-wty-ja-zh']));

    const remove = screen.getByTestId('dict-remove-jpdb-freq');
    fireEvent.click(remove);
    expect(remove.textContent).toContain('确认删除？');
    expect(screen.getByTestId('dict-row-jpdb-freq')).toBeInTheDocument();
    fireEvent.click(remove);
    await waitFor(() => expect(screen.queryByTestId('dict-row-jpdb-freq')).toBeNull());
    expect((await host.dict!.list()).map((d) => d.id)).not.toContain('jpdb-freq');
  });

  it('one-click preset download imports with live progress (zero-dict start)', async () => {
    const host = await setup({ dictionaries: 'empty' }, true);
    expect(screen.getByTestId('dict-installed-empty')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId('dict-preset-install-wty-ja-zh'));
    });
    await waitFor(() => expect(screen.getByTestId('dict-row-wty-ja-zh')).toBeInTheDocument());
    expect(screen.getByTestId('dict-import-progress-wty-ja-zh')).toHaveAttribute('data-phase', 'ready');
    expect(host.calls.get('dict.importZip')).toBe(1);
    expect(screen.getByTestId('dict-preset-install-wty-ja-zh').textContent).toBe('重新下载更新');
  });

  it('records downloading / importing progress events from the host (both inline card and dialog)', async () => {
    const host = await setup({}, true);
    act(() => host.emit({ type: 'dict-import-progress', dictId: 'jmdict-en', title: 'JMdict (English)', phase: 'downloading', processedRows: 0 }));
    expect(screen.getByTestId('dict-card-progress').textContent).toContain('下载中');
    expect(screen.getByTestId('dict-import-progress-jmdict-en').textContent).toContain('下载中');
    act(() => host.emit({ type: 'dict-import-progress', dictId: 'jmdict-en', title: 'JMdict (English)', phase: 'importing', processedRows: 12500 }));
    expect(screen.getByTestId('dict-import-progress-jmdict-en').textContent).toContain('12,500');
    act(() => host.emit({ type: 'dict-import-progress', dictId: 'jmdict-en', title: 'JMdict (English)', phase: 'failed', processedRows: 12500, error: 'HTTP 404' }));
    expect(screen.getByTestId('dict-import-progress-jmdict-en').textContent).toContain('HTTP 404');
  });

  it('imports a local Yomitan .zip via the hidden file input', async () => {
    const host = await setup({}, true);
    const input = screen.getByTestId('dict-import-zip-input') as HTMLInputElement;
    expect(input).toHaveAttribute('accept', '.zip,application/zip');
    let clicked = false;
    input.addEventListener('click', () => (clicked = true));
    fireEvent.click(screen.getByTestId('dict-import-zip-btn'));
    expect(clicked).toBe(true);

    const zip = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])], 'my-dict.zip', { type: 'application/zip' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [zip] } });
    });
    await waitFor(() => expect(within(screen.getByTestId('dict-installed-list')).getByText('my-dict')).toBeInTheDocument());
    expect(host.calls.get('dict.importZip')).toBe(1);
    expect((await host.dict!.list()).some((d) => d.title === 'my-dict')).toBe(true);
  });

  it('reports a failed import of a non-ZIP file', async () => {
    await setup({}, true);
    const input = screen.getByTestId('dict-import-zip-input') as HTMLInputElement;
    const bad = new File([new Uint8Array([0x7b, 0x7d])], 'notes.zip');
    await act(async () => {
      fireEvent.change(input, { target: { files: [bad] } });
    });
    await waitFor(() => expect(screen.getByTestId('dict-import-progress-file:notes.zip')).toHaveAttribute('data-phase', 'failed'));
    expect(screen.getByTestId('dict-import-progress-file:notes.zip').textContent).toContain('not a ZIP archive');
  });

  it('external download guide opens the original link', async () => {
    const host = await setup({}, true);
    fireEvent.click(screen.getByTestId('dict-preset-guide-jpdb-freq'));
    expect(host.calls.get('dict.openExternal') ?? host.calls.get('files.openExternal')).toBe(1);
  });

  it('hosts without dictionary support show a notice', async () => {
    const host = createMockPlatformHost({ latencyMs: 0, dictionaries: 'absent' });
    render(
      <HostProvider host={host}>
        <DictionarySection />
      </HostProvider>,
    );
    expect(screen.getByTestId('settings-dictionary-section').textContent).toContain('暂不支持');
  });
});
