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
import { Menu, type MenuHeading, type MenuItem } from '../../../components/m3/Menu';
import { useHost } from '../../../host/HostContext';
import type { Translate } from '../../../i18n';
import { showSnackbar } from '../../../stores/snackbar';

export interface TrackSelectionTarget {
  readonly primary?: string | undefined;
  readonly secondary?: string | undefined;
}

export interface SubtitleTrackMenuProps {
  readonly episode: AnimeEpisode;
  readonly trackId: string | undefined;
  readonly secondaryTrackId: string | undefined;
  readonly onSelectTrack: (trackId: string) => void;
  readonly onSelectSecondaryTrack: (trackId: string | null) => void;
  /** After any host-side change to the episode's tracks. `select` names which slot an extracted / added track goes to. */
  readonly onTracksChanged: (select?: TrackSelectionTarget) => void;
  readonly t: Translate;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const LANG_NAMES: Readonly<Record<string, string>> = {
  ja: '日本語',
  jpn: '日本語',
  zh: '中文',
  'zh-cn': '简中',
  'zh-tw': '繁中',
  en: 'English',
  eng: 'English',
};

const ORIGIN_NAMES: Readonly<Record<string, string>> = {
  jimaku: 'Jimaku',
  ajatt: 'AJATT',
  embedded: '内嵌',
  external: '外挂',
  imported: '导入',
};

/**
 * Format a concise, mobile-friendly label for a subtitle track so 70-character
 * raw release filenames (`Jimaku · [SubsPlease] ... - 01 (1080p) [CRC].ja.ass`)
 * never overflow the track menu.
 */
export function formatSubtitleTrackLabel(track: SubtitleTrack, episode: AnimeEpisode): string {
  const langKey = (track.language ?? '').toLowerCase();
  const langLabel = LANG_NAMES[langKey] ?? (track.language ? track.language.toUpperCase() : undefined);
  const fmtLabel = track.format.toUpperCase();
  const originLabel = ORIGIN_NAMES[track.origin] ?? track.origin;

  const videoStem = episode.fileName.replace(/\.[^.]+$/, '');
  let cleaned = track.label
    .replace(/^(?:Jimaku|AJATT|External|Embedded|Imported)\s*·\s*/i, '')
    .replace(/\.(?:ass|ssa|srt|vtt)$/i, '')
    .trim();
  if (videoStem && cleaned.toLowerCase().startsWith(videoStem.toLowerCase())) {
    cleaned = cleaned.slice(videoStem.length).replace(/^[.\s_-]+/, '');
  }
  // Strip release groups, CRC hashes, resolution tags, and language extensions if it's still a raw filename.
  if (cleaned.length > 24 || cleaned.includes('[') || cleaned.includes('1080p') || cleaned.includes('720p')) {
    cleaned = cleaned
      .replace(/\[[^\]]*\]/g, '')
      .replace(/\([^)]*(?:1080p|720p|2160p|480p|BD|WEB|HEVC|x264|x265|AAC|FLAC)[^)]*\)/gi, '')
      .replace(/(?:^|[.\s_-])(?:ja|jpn|jp|en|eng|zh|chs|cht|sc|tc)$/i, '')
      .trim();
    // If what remains is just the series/episode name, omit it in favor of clean metadata tags.
    if (
      cleaned.length > 22 ||
      (episode.parsedName.title && cleaned.toLowerCase().includes(episode.parsedName.title.toLowerCase()))
    ) {
      cleaned = '';
    }
  } else {
    cleaned = cleaned.replace(/^(?:ja|jpn|jp|en|eng|zh|chs|cht)\b[.\s·_-]*/i, '').trim();
  }

  const parts = [langLabel, fmtLabel, originLabel, cleaned].filter((x): x is string => Boolean(x && x.trim()));
  const base = parts.length > 0 ? parts.join(' · ') : track.label;
  return `${base}${track.delayMs ? ` (${track.delayMs > 0 ? '+' : ''}${track.delayMs}ms)` : ''}`;
}

export function SubtitleTrackMenu({
  episode,
  trackId,
  secondaryTrackId,
  onSelectTrack,
  onSelectSecondaryTrack,
  onTracksChanged,
  t,
}: SubtitleTrackMenuProps) {
  const host = useHost();
  const caps = host.info.capabilities;
  const [addOpen, setAddOpen] = useState(false);
  const [path, setPath] = useState('');
  const current = episode.subtitleTracks.find((x) => x.id === trackId);
  const currentSecondary = secondaryTrackId ? episode.subtitleTracks.find((x) => x.id === secondaryTrackId) : undefined;

  const extract = async (track: SubtitleTrack, slot: 'primary' | 'secondary'): Promise<void> => {
    if (track.streamIndex === undefined) return;
    try {
      const extracted = await host.anime.extractEmbeddedTrack(episode.id, track.streamIndex);
      if (slot === 'secondary') {
        onTracksChanged({ secondary: extracted.id });
        showSnackbar(t('player.secondaryOn', { label: formatSubtitleTrackLabel(extracted, episode) }));
      } else {
        onTracksChanged({ primary: extracted.id });
      }
    } catch (e) {
      showSnackbar(errMsg(e), { tone: 'error' });
    }
  };

  const setDelay = async (track: SubtitleTrack, delta: number): Promise<void> => {
    try {
      await host.anime.setTrackDelay(track.id, track.delayMs + delta);
      onTracksChanged();
    } catch (e) {
      showSnackbar(errMsg(e), { tone: 'error' });
    }
  };

  const items: (MenuItem | MenuHeading)[] = [];
  items.push({ key: 'h:primary', heading: t('player.primaryTrackSection') });
  for (const track of episode.subtitleTracks) {
    const needsExtract = track.origin === 'embedded' && !track.filePath;
    items.push({
      key: `p:${track.id}`,
      testId: `track-primary-${track.id}`,
      label: formatSubtitleTrackLabel(track, episode),
      selected: track.id === trackId,
      disabled: needsExtract && !caps.embeddedSubtitles,
      onSelect: () => {
        if (needsExtract) {
          void extract(track, 'primary');
        } else {
          onSelectTrack(track.id);
        }
      },
    });
  }
  items.push({ key: 'h:secondary', heading: t('player.secondaryTrackSection') });
  items.push({
    key: 's:__off',
    testId: 'track-secondary-off',
    label: t('player.secondaryOff'),
    selected: secondaryTrackId === undefined,
    onSelect: () => onSelectSecondaryTrack(null),
  });
  for (const track of episode.subtitleTracks) {
    if (track.id === trackId) continue;
    const needsExtract = track.origin === 'embedded' && !track.filePath;
    items.push({
      key: `s:${track.id}`,
      testId: `track-secondary-${track.id}`,
      label: formatSubtitleTrackLabel(track, episode),
      selected: track.id === secondaryTrackId,
      disabled: needsExtract && !caps.embeddedSubtitles,
      onSelect: () => {
        if (needsExtract) {
          void extract(track, 'secondary');
        } else {
          onSelectSecondaryTrack(track.id);
        }
      },
    });
  }
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
        {(current || currentSecondary) && (
          <div className="k-track-delays">
            {current && (
              <div className="k-track-delay" data-testid="track-delay-primary">
                <span>{t(currentSecondary ? 'player.primaryDelay' : 'player.delay', { ms: current.delayMs })}</span>
                <Button variant="text" onClick={() => void setDelay(current, -100)}>
                  −100
                </Button>
                <Button variant="text" onClick={() => void setDelay(current, 100)}>
                  +100
                </Button>
              </div>
            )}
            {currentSecondary && (
              <div className="k-track-delay" data-testid="track-delay-secondary">
                <span>{t('player.secondaryDelay', { ms: currentSecondary.delayMs })}</span>
                <Button variant="text" onClick={() => void setDelay(currentSecondary, -100)}>
                  −100
                </Button>
                <Button variant="text" onClick={() => void setDelay(currentSecondary, 100)}>
                  +100
                </Button>
              </div>
            )}
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
                    onTracksChanged({ primary: track.id });
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
