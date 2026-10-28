import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useRouteStore } from '../../app/routes';
import { HostProvider } from '../../host/HostContext';
import { createMockPlatformHost } from '../../host/mock-host';
import { AnimePage } from './AnimePage';
import { ImportSeriesDialog } from './ImportSeriesDialog';
import { SeriesDetail } from './SeriesDetail';
import { useAnimeStore } from './useAnimeStore';

beforeEach(() => {
  useAnimeStore.getState().reset();
  useRouteStore.getState().reset();
});
afterEach(cleanup);

describe('SeriesDetail & EditSeriesDialog', () => {
  it('requires user confirmation before linking AniList on unlinked series, and supports editing & unlinking in EditSeriesDialog', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    const imported = await host.anime.importSeries({ path: '/home/kotori/Videos/Bocchi the Rock!' });
    expect(imported.anilistId).toBeUndefined();
    await useAnimeStore.getState().loadSeries(host);

    render(
      <HostProvider host={host}>
        <SeriesDetail seriesId={imported.id} />
      </HostProvider>,
    );

    // Unlinked series shows its folder/user title and a non-intrusive confirmation banner rather than silently overwriting
    expect(await screen.findByRole('heading', { name: 'Bocchi the Rock!' })).toBeInTheDocument();
    const banner = await screen.findByTestId('anilist-confirm-banner');
    expect(banner).toHaveTextContent('ぼっち・ざ・ろっく！');

    // Open EditSeriesDialog via edit-series-btn
    fireEvent.click(screen.getByTestId('edit-series-btn'));
    const dialog = await screen.findByTestId('edit-series-dialog');
    expect(dialog).toBeInTheDocument();

    // Search AniList and link a candidate + customize title
    const searchInput = screen.getByTestId('edit-series-search-input');
    fireEvent.change(searchInput, { target: { value: 'Frieren' } });
    fireEvent.click(screen.getByTestId('edit-series-search-btn'));
    const candidate = await screen.findByTestId('edit-series-candidate-154587');
    fireEvent.click(candidate);

    const titleInput = screen.getByTestId('edit-series-title-input');
    fireEvent.change(titleInput, { target: { value: '葬送のフリーレン（收藏版）' } });
    fireEvent.click(screen.getByTestId('edit-series-save-btn'));

    await waitFor(() => expect(screen.queryByTestId('edit-series-dialog')).toBeNull());
    expect(await screen.findByRole('heading', { name: '葬送のフリーレン（收藏版）' })).toBeInTheDocument();
    expect(screen.queryByTestId('anilist-confirm-banner')).toBeNull();
    expect((await host.anime.getSeries(imported.id)).anilistId).toBe(154587);

    // Reopen EditSeriesDialog and unlink AniList
    fireEvent.click(screen.getByTestId('edit-series-btn'));
    await screen.findByTestId('edit-series-dialog');
    fireEvent.change(screen.getByTestId('edit-series-title-input'), { target: { value: 'NogiKouji' } });
    fireEvent.click(screen.getByTestId('edit-series-unlink-btn'));
    fireEvent.click(screen.getByTestId('edit-series-save-btn'));

    await waitFor(() => expect(screen.queryByTestId('edit-series-dialog')).toBeNull());
    expect(await screen.findByRole('heading', { name: 'NogiKouji' })).toBeInTheDocument();
    const afterUnlink = await host.anime.getSeries(imported.id);
    expect(afterUnlink.anilistId).toBeUndefined();
    expect(afterUnlink.coverUrl).toBeUndefined();
  });

  it('ImportSeriesDialog defaults to NOT linking AniList unless a candidate is explicitly selected', async () => {
    const host = createMockPlatformHost({ latencyMs: 0 });
    render(
      <HostProvider host={host}>
        <ImportSeriesDialog open onClose={() => {}} />
      </HostProvider>,
    );

    // Select folder via PathBrowser and enter title that matches Bocchi in AniList
    fireEvent.click(await screen.findByRole('button', { name: '选择此文件夹' }));
    const titleField = screen.getByRole('textbox');
    fireEvent.change(titleField, { target: { value: 'Bocchi the Rock!' } });

    const picker = await screen.findByTestId('import-anilist-candidates');
    expect(picker).toBeInTheDocument();
    const noneOption = screen.getByTestId('import-anilist-none');
    expect(noneOption).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('button', { name: '导入' }));
    await waitFor(async () => {
      const list = await host.anime.listSeries();
      expect(list.some((s) => s.title === 'Bocchi the Rock!' && s.anilistId === undefined)).toBe(true);
    });
  });

  it('removes an open series cleanly without triggering "Series ... not found" on invalidate or leaving stale back history', async () => {
    const host = createMockPlatformHost({ latencyMs: 5 });
    const initial = await host.anime.listSeries();
    const target = initial[0]!;

    render(
      <HostProvider host={host}>
        <AnimePage />
      </HostProvider>,
    );

    // Open SeriesDetail from AnimeLibrary so episodes[target.id] is populated and route history records library -> series
    const card = await screen.findByTestId(`series-${target.id}`);
    fireEvent.click(card);
    await waitFor(() => expect(useAnimeStore.getState().episodes[target.id]?.length).toBeGreaterThan(0));

    // Click remove ("移出库")
    fireEvent.click(await screen.findByTestId('remove-series-btn'));

    // Returns to AnimeLibrary with zero error banner and removed series evicted from store + route history
    await waitFor(() => expect(useRouteStore.getState().anime.kind).toBe('library'));
    await waitFor(async () => {
      const remaining = await host.anime.listSeries();
      expect(remaining.some((s) => s.id === target.id)).toBe(false);
    });
    await useAnimeStore.getState().invalidate(host);

    expect(useAnimeStore.getState().error).toBeUndefined();
    expect(useAnimeStore.getState().episodes[target.id]).toBeUndefined();
    expect(document.querySelector('.k-error-text')).toBeNull();
    expect(screen.queryByTestId(`series-${target.id}`)).toBeNull();

    // Pressing Back must NOT navigate back to the deleted series
    expect(useRouteStore.getState().goBack()).toBe(false);
    expect(useRouteStore.getState().anime).toEqual({ kind: 'library' });

    // Even if loadEpisodes is called directly for a vanished seriesId, not-found does not pollute global error
    await useAnimeStore.getState().loadEpisodes(host, 'sr_607d98a31fe5a05e');
    expect(useAnimeStore.getState().error).toBeUndefined();
  });
});
