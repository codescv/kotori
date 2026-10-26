/**
 * Subtitle track menu: choose track, adjust delay (±100 ms), extract an MKV
 * embedded stream (when `capabilities.embeddedSubtitles`), add a subtitle
 * file (path browser / picker), or auto-fetch from Jimaku.
 */
import { useState } from 'react';
import type { AnimeEpisode, SubtitleTrack } from '@kotori/core';
import { PathBrowser } from '../../../components/PathBrowser';
import { Button } from '../../../components/m3/Button';
import { Dialog } from '../../../components/m3/Dialog';
import { IconButton } from '../../../components/m3/IconButton';
import { Menu, type MenuItem } from '../../../components/m3/Menu';
import { useHost } from '../../../host/HostContext';
import type { Translate } from '../../../i18n';
import { showSnackbar } from '../../../stores/snackbar';

export interface SubtitleTrackMenuProps {
  readonly episode: AnimeEpisode;
  readonly trackId: string | undefined;
  readonly onSelectTrack: (trackId: string) => void;
  /** Called after any host-side change to the episode's tracks. */
  readonly onTracksChanged: (selectTrackId?: string) => void;
  readonly t: Translate;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function SubtitleTrackMenu({ episode, trackId, onSelectTrack, onTracksChanged, t }: SubtitleTrackMenuProps) {
  const host = useHost();
  const caps = host.info.capabilities;
  const [addOpen, setAddOpen] = useState(false);
  const [path, setPath] = useState('');
  const current = episode.subtitleTracks.find((x) => x.id === trackId);

  const extract = async (track: SubtitleTrack): Promise<void> => {
    if (track.streamIndex === undefined) return;
    try {
      const extracted = await host.anime.extractEmbeddedTrack(episode.id, track.streamIndex);
      onTracksChanged(extracted.id);
    } catch (e) {
      showSnackbar(errMsg(e), { tone: 'error' });
    }
  };

  const setDelay = async (delta: number): Promise<void> => {
    if (!current) return;
    try {
      await host.anime.setTrackDelay(current.id, current.delayMs + delta);
      onTracksChanged(current.id);
    } catch (e) {
      showSnackbar(errMsg(e), { tone: 'error' });
    }
  };

  const items: MenuItem[] = episode.subtitleTracks.map((track) => {
    const needsExtract = track.origin === 'embedded' && !track.filePath;
    return {
      key: track.id,
      label: `${track.label}${track.delayMs ? ` (${track.delayMs > 0 ? '+' : ''}${track.delayMs}ms)` : ''}`,
      selected: track.id === trackId,
      disabled: needsExtract && !caps.embeddedSubtitles,
      onSelect: () => (needsExtract ? void extract(track) : onSelectTrack(track.id)),
    };
  });
  items.push({ key: '__add', label: t('player.addFile'), icon: 'add', onSelect: () => setAddOpen(true) });
  items.push({
    key: '__jimaku',
    label: t('player.autoJimaku'),
    icon: 'cloud',
    onSelect: () =>
      void host.anime
        .autoFetchJimaku(episode.seriesId)
        .then((tasks) => showSnackbar(t('anime.series.autoJimakuStarted', { count: tasks.length })))
        .catch((e: unknown) => showSnackbar(errMsg(e), { tone: 'error' })),
  });

  return (
    <>
      <Menu
        align="end"
        items={items}
        header={t('player.tracks')}
        trigger={({ toggle, open }) => <IconButton icon="subtitles" label={t('player.tracks')} selected={open} onClick={toggle} />}
      >
        {current && (
          <div className="k-track-delay">
            <span>{t('player.delay', { ms: current.delayMs })}</span>
            <Button variant="text" onClick={() => void setDelay(-100)}>
              −100
            </Button>
            <Button variant="text" onClick={() => void setDelay(100)}>
              +100
            </Button>
          </div>
        )}
      </Menu>
      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title={t('player.addFile')}
        wide
        actions={
          <>
            <Button variant="text" onClick={() => setAddOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={!path}
              onClick={() => {
                const fileName = path.split('/').pop() ?? path;
                host.anime
                  .addSubtitleTrack(episode.id, { path, fileName, ...(/\.ja\.|日本語|jpn/i.test(fileName) ? { language: 'ja' } : {}) })
                  .then((track) => {
                    setAddOpen(false);
                    onTracksChanged(track.id);
                  })
                  .catch((e: unknown) => showSnackbar(errMsg(e), { tone: 'error' }));
              }}
            >
              {t('common.import')}
            </Button>
          </>
        }
      >
        <PathBrowser value={path} onChange={setPath} select="file" accept={['srt', 'ass', 'ssa', 'vtt']} />
      </Dialog>
    </>
  );
}
