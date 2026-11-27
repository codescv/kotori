import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnimeEpisode, SubtitleTrack } from '@kotori/core';
import { DEFAULT_SETTINGS } from '../../../app/default-settings';
import { createTranslator } from '../../../i18n';
import { useSettingsStore } from '../../../stores/settings';
import { renderWithHost, resetStores } from '../../../test/utils';
import { formatSubtitleTrackLabel, SubtitleTrackMenu } from './SubtitleTrackMenu';

const tZh = createTranslator('zh-CN');
const tEn = createTranslator('en');
const tJa = createTranslator('ja');

const EPISODE: AnimeEpisode = {
  id: 'ep-1',
  seriesId: 'sr-1',
  title: '第1話',
  fileName: '[SubsPlease] Sousou no Frieren - 01 (1080p) [ABCD1234].mkv',
  filePath: '/anime/frieren/ep01.mkv',
  container: 'mkv',
  sizeBytes: 1024,
  parsedName: { raw: '[SubsPlease] Sousou no Frieren - 01 (1080p) [ABCD1234].mkv', title: 'Sousou no Frieren', episode: 1, isBatch: false },
  mediaUrl: '/media/ep-1',
  subtitleTracks: [
    {
      id: 'tr-vtt',
      episodeId: 'ep-1',
      origin: 'external',
      format: 'vtt',
      label: 'JA (vtt)',
      language: 'ja',
      filePath: '/anime/frieren/ep01.ja.vtt',
      isDefault: true,
      delayMs: 0,
    },
    {
      id: 'tr-srt',
      episodeId: 'ep-1',
      origin: 'external',
      format: 'srt',
      label: 'JA (srt)',
      language: 'ja',
      filePath: '/anime/frieren/ep01.ja.srt',
      isDefault: false,
      delayMs: 0,
    },
  ],
};

describe('SubtitleTrackMenu · formatSubtitleTrackLabel & furigana mode switcher', () => {
  beforeEach(() => {
    resetStores();
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  });

  it('formats .ja.vtt and sidecar tracks cleanly without redundant format suffixes', () => {
    const vttTrack: SubtitleTrack = EPISODE.subtitleTracks[0]!;
    expect(formatSubtitleTrackLabel(vttTrack, EPISODE, tZh)).toBe('日语 · VTT · 外挂');
    expect(formatSubtitleTrackLabel(vttTrack, EPISODE, tEn)).toBe('Japanese · VTT · External');
    expect(formatSubtitleTrackLabel(vttTrack, EPISODE, tJa)).toBe('日本語 · VTT · 外部');

    expect(
      formatSubtitleTrackLabel({ ...vttTrack, label: 'JA (VTT)' }, EPISODE, tZh),
    ).toBe('日语 · VTT · 外挂');
    expect(
      formatSubtitleTrackLabel(
        { ...vttTrack, label: '[SubsPlease] Sousou no Frieren - 01 (1080p) [ABCD1234].ja.vtt' },
        EPISODE,
        tZh,
      ),
    ).toBe('日语 · VTT · 外挂');
    const { language: _lang, ...untaggedBase } = vttTrack;
    expect(
      formatSubtitleTrackLabel(
        { ...untaggedBase, format: 'srt', label: 'External (srt)' },
        EPISODE,
        tZh,
      ),
    ).toBe('SRT · 外挂');
    expect(
      formatSubtitleTrackLabel(
        { ...vttTrack, format: 'srt', language: 'ja', label: 'JA ja-proofread (srt)' },
        EPISODE,
        tZh,
      ),
    ).toBe('日语 · SRT · 外挂 · ja-proofread');
  });

  it('renders a compact furigana mode switcher bound to settings.anime.furiganaMode', async () => {
    const { host } = renderWithHost(
      <SubtitleTrackMenu
        episode={EPISODE}
        trackId="tr-vtt"
        secondaryTrackId={undefined}
        onSelectTrack={vi.fn()}
        onSelectSecondaryTrack={vi.fn()}
        onTracksChanged={vi.fn()}
        t={tZh}
      />,
    );

    // Open the track menu
    fireEvent.click(screen.getByRole('button', { name: tZh('player.tracks') }));
    const row = screen.getByTestId('track-furigana-mode');
    expect(within(row).getByText(tZh('player.furigana'))).toBeInTheDocument();

    const btnAll = screen.getByTestId('track-furigana-all');
    const btnTap = screen.getByTestId('track-furigana-tap');
    const btnOff = screen.getByTestId('track-furigana-off');
    expect(btnAll).toHaveAttribute('aria-checked', 'true');
    expect(btnTap).toHaveAttribute('aria-checked', 'false');
    expect(btnOff).toHaveAttribute('aria-checked', 'false');

    // Switch to 'tap' — menu stays open and settings persist to host
    fireEvent.click(btnTap);
    await waitFor(() => expect(useSettingsStore.getState().settings.anime.furiganaMode).toBe('tap'));
    expect(btnTap).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect((await host.settings.get()).anime.furiganaMode).toBe('tap');

    // Switch to 'off'
    fireEvent.click(btnOff);
    await waitFor(() => expect(useSettingsStore.getState().settings.anime.furiganaMode).toBe('off'));
    expect(btnOff).toHaveAttribute('aria-checked', 'true');
    expect((await host.settings.get()).anime.furiganaMode).toBe('off');
  });
});
