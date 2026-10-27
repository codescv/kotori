/**
 * Episode player: `<video>` + clickable subtitle overlay + transcript /
 * AI-breakdown drawer (docked side sheet ≥ 840 px, bottom sheet on phones).
 *
 * Keyboard: Space play/pause · ←/→ previous/next line · R repeat line ·
 * B blind listening · Esc close breakdown. Progress is saved fire-and-forget.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnimeEpisode, SubtitleCue, SubtitleTrack, TranscriptRow } from '@kotori/core';
import { BreakdownPanel } from '../../../components/breakdown/AiBreakdownPanel';
import { cx } from '../../../components/m3/cx';
import { Icon } from '../../../components/m3/Icon';
import { IconButton } from '../../../components/m3/IconButton';
import { Menu } from '../../../components/m3/Menu';
import { CircularProgress } from '../../../components/m3/Progress';
import { BottomSheet, SideSheet } from '../../../components/m3/Sheet';
import { Tabs, useTabSwipe } from '../../../components/m3/Tabs';
import { useHost } from '../../../host/HostContext';
import { useAsync } from '../../../host/useAsync';
import { useIsExpanded } from '../../../hooks/useMediaQuery';
import { useT } from '../../../i18n';
import { buildTranscriptRows, formatAnimeEpisodeTitle, formatAnimeSeriesTitle, formatClock } from '../../../lib/cues';
import { useBackInterceptor, useRouteStore } from '../../../app/routes';
import { useBreakdownStore } from '../../../stores/breakdown';
import { useSettingsStore } from '../../../stores/settings';
import { showSnackbar } from '../../../stores/snackbar';
import { RepeatControls, useRepeat } from './RepeatControls';
import { SubtitleOverlay } from './SubtitleOverlay';
import { SubtitleTrackMenu } from './SubtitleTrackMenu';
import { activeRowIndex, TranscriptPanel } from './TranscriptPanel';
import { useMediaClock, usePlayerSync } from './usePlayerSync';
import { useSubtitleBreakdown } from './useSubtitleBreakdown';
import { useSubtitlePreExplain } from './useSubtitlePreExplain';
import './player.css';

type PanelTab = 'transcript' | 'breakdown';

/** Default track: explicit default → preferred language → first playable. */
export function pickDefaultTrack(episode: AnimeEpisode, preferred: readonly string[]): SubtitleTrack | undefined {
  const playable = episode.subtitleTracks.filter((t) => t.origin !== 'embedded' || t.filePath);
  return (
    playable.find((t) => t.isDefault) ??
    preferred.map((lang) => playable.find((t) => t.language === lang)).find(Boolean) ??
    playable[0]
  );
}

const EMPTY_CUES: readonly SubtitleCue[] = [];

/** Loads the episode, then mounts the player (so the clock starts at the saved position). */
export function Player({ seriesId, episodeId }: { readonly seriesId: string; readonly episodeId: string }) {
  const host = useHost();
  const t = useT();
  const episodeQ = useAsync(() => host.anime.getEpisode(episodeId), [host, episodeId]);
  if (episodeQ.error) return <div className="k-page k-error-text">{t('common.error', { message: episodeQ.error.message })}</div>;
  if (!episodeQ.data) {
    return (
      <div className="k-page k-empty">
        <CircularProgress />
      </div>
    );
  }
  return <PlayerView seriesId={seriesId} episode={episodeQ.data} reloadEpisode={episodeQ.reload} />;
}

function PlayerView({ seriesId, episode, reloadEpisode }: { readonly seriesId: string; readonly episode: AnimeEpisode; readonly reloadEpisode: () => void }) {
  const host = useHost();
  const t = useT();
  const expanded = useIsExpanded();
  const animeSettings = useSettingsStore((s) => s.settings.anime);
  const updateSettings = useSettingsStore((s) => s.update);
  const openAnime = useRouteStore((s) => s.openAnime);
  const episodeId = episode.id;

  const seriesQ = useAsync(() => host.anime.getSeries(seriesId), [host, seriesId]);
  const [trackId, setTrackId] = useState<string | undefined>(() => pickDefaultTrack(episode, animeSettings.preferredSubtitleLanguages)?.id);
  useEffect(() => {
    if (!trackId || !episode.subtitleTracks.some((x) => x.id === trackId)) {
      setTrackId(pickDefaultTrack(episode, animeSettings.preferredSubtitleLanguages)?.id);
    }
  }, [episode, trackId, animeSettings.preferredSubtitleLanguages]);
  const [cuesNonce, setCuesNonce] = useState(0);
  const cuesQ = useAsync(async () => (trackId ? host.anime.getCues(trackId) : undefined), [host, trackId, cuesNonce]);
  const cues = cuesQ.data?.cues ?? EMPTY_CUES;

  const videoRef = useRef<HTMLVideoElement>(null);
  const clock = useMediaClock(videoRef, { durationHintMs: episode.durationMs, startMs: episode.progress?.positionMs });
  const sync = usePlayerSync(cues, clock.currentMs);
  const rows = useMemo(() => buildTranscriptRows(cues, { mergeKaraoke: animeSettings.mergeKaraokeCues, hideSigns: animeSettings.hideSigns }), [cues, animeSettings.mergeKaraokeCues, animeSettings.hideSigns]);
  const activeRaw = useMemo(() => new Set(sync.activeIndexes.map((i) => cues[i]?.index ?? -1)), [sync.activeIndexes, cues]);
  const rowCues = useMemo(() => rows.map((r) => r.cue), [rows]);
  const sb = useSubtitleBreakdown({ episodeId, trackId, contextCues: rowCues, sceneHint: seriesQ.data?.title });

  const [blind, setBlind] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelTab, setPanelTab] = useState<PanelTab>('transcript');
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [pauseAt, setPauseAt] = useState<number | undefined>(undefined);
  const repeat = useRepeat(clock.currentMs, clock.seek, animeSettings.seekPaddingMs);
  const breakdownOpen = useBreakdownStore((s) => s.isOpen);
  const closeBreakdown = useBreakdownStore((s) => s.close);
  const sideSheetSwipe = useTabSwipe<PanelTab>(['transcript', 'breakdown'], panelTab, setPanelTab);

  useBackInterceptor(() => {
    if (useBreakdownStore.getState().isOpen) {
      closeBreakdown();
      setPanelTab('transcript');
      return true;
    }
    return false;
  });

  // Opening a breakdown brings its tab forward (expanded) / its sheet up (compact).
  useEffect(() => {
    if (breakdownOpen) {
      setPanelOpen(true);
      setPanelTab('breakdown');
    }
  }, [breakdownOpen]);
  useEffect(() => () => useBreakdownStore.getState().close(), []);

  // Register audio slice replay handler for the AI Breakdown panel (`🔊 原声`).
  useEffect(() => {
    const setHandler = useBreakdownStore.getState().setAudioReplayHandler;
    setHandler((startMs: number, endMs: number) => {
      clock.seek(Math.max(0, startMs - 80));
      setPauseAt(Math.max(startMs + 250, endMs + 120));
      clock.play();
    });
    return () => setHandler(undefined);
  }, [clock]);

  // Pause at the end of a line after a jump (AnimeSettings.pauseAfterJump).
  useEffect(() => {
    if (pauseAt !== undefined && clock.currentMs >= pauseAt) {
      clock.pause();
      setPauseAt(undefined);
    }
  }, [clock, pauseAt]);

  // Fire-and-forget progress persistence (every 5 s while playing + on leave).
  const progressRef = useRef({ positionMs: 0, durationMs: 0 });
  progressRef.current = { positionMs: clock.currentMs, durationMs: clock.durationMs || episode.durationMs || 0 };
  useEffect(() => {
    if (!clock.playing) return;
    const id = setInterval(() => void host.anime.saveProgress(episodeId, { ...progressRef.current, updatedAt: Date.now() }).catch(() => {}), 5000);
    return () => clearInterval(id);
  }, [clock.playing, host, episodeId]);
  useEffect(
    () => () => {
      if (progressRef.current.positionMs > 0) void host.anime.saveProgress(episodeId, { ...progressRef.current, updatedAt: Date.now() }).catch(() => {});
    },
    [host, episodeId],
  );

  const jumpToRow = useCallback(
    (row: TranscriptRow | undefined) => {
      if (!row) return;
      clock.seek(Math.max(0, row.cue.startMs - animeSettings.seekPaddingMs));
      if (animeSettings.pauseAfterJump) setPauseAt(row.cue.endMs);
    },
    [clock, animeSettings.seekPaddingMs, animeSettings.pauseAfterJump],
  );

  const currentRowIdx = activeRowIndex(rows, activeRaw, clock.currentMs);
  const preExplain = useSubtitlePreExplain({
    enabled: Boolean(animeSettings.autoPreExplain),
    episodeId,
    trackId,
    rows,
    currentRowIdx,
    sceneHint: seriesQ.data?.title,
  });
  const togglePreExplain = useCallback(() => {
    const next = !animeSettings.autoPreExplain;
    void updateSettings(host, { anime: { autoPreExplain: next } });
    showSnackbar(t(next ? 'player.preExplainOn' : 'player.preExplainOff'));
  }, [animeSettings.autoPreExplain, updateSettings, host, t]);

  const nextRow = useCallback(() => {
    const ms = clock.currentMs + animeSettings.seekPaddingMs + 10;
    jumpToRow(rows.find((r, i) => i !== currentRowIdx && r.cue.startMs > ms));
  }, [rows, currentRowIdx, clock.currentMs, animeSettings.seekPaddingMs, jumpToRow]);
  const prevRow = useCallback(() => {
    const cur = rows[currentRowIdx];
    if (cur && clock.currentMs - cur.cue.startMs > 1500) return jumpToRow(cur);
    const before = rows.filter((r, i) => i !== currentRowIdx && r.cue.startMs < (cur?.cue.startMs ?? clock.currentMs));
    jumpToRow(before[before.length - 1]);
  }, [rows, currentRowIdx, clock.currentMs, jumpToRow]);

  const toggleRepeatCue = useCallback(() => {
    if (repeat.state?.kind === 'cue') return repeat.stop();
    const row = rows[currentRowIdx] ?? rows.filter((r) => r.cue.startMs <= clock.currentMs).pop();
    if (!row) return;
    repeat.startCue(row.cue.startMs, Math.max(row.cue.endMs, row.chainEndMs), animeSettings.repeatCount);
    if (!clock.playing) clock.play();
  }, [repeat, rows, currentRowIdx, clock, animeSettings.repeatCount]);

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.rep)), [rows, selected]);
  const toggleAb = useCallback(() => {
    if (repeat.state?.kind === 'ab') return repeat.stop();
    if (selectedRows.length === 0) return;
    const start = Math.min(...selectedRows.map((r) => r.cue.startMs));
    const end = Math.max(...selectedRows.map((r) => Math.max(r.cue.endMs, r.chainEndMs)));
    repeat.startAb(start, end);
    clock.seek(Math.max(0, start - animeSettings.seekPaddingMs));
    if (!clock.playing) clock.play();
  }, [repeat, selectedRows, clock, animeSettings.seekPaddingMs]);

  const onOverlayChar = useCallback(
    (cue: SubtitleCue, i: number) => {
      clock.pause();
      sb.openCue(cue, i);
    },
    [clock, sb],
  );

  // Touch & pointer precision listening gestures:
  // - Long-press (450 ms) on video stage -> temporary 2.0x speed
  // - Double-tap / double-click left 35% -> prevRow, right 35% -> nextRow, center 30% -> fullscreen
  const [longPressFast, setLongPressFast] = useState(false);
  const [gestureToast, setGestureToast] = useState<string | undefined>(undefined);
  const savedRateRef = useRef<number>(1);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flashGestureToast = useCallback((label: string) => {
    setGestureToast(label);
    if (toastTimerRef.current !== undefined) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setGestureToast(undefined), 900);
  }, []);

  const endLongPress = useCallback(() => {
    if (longPressTimerRef.current !== undefined) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = undefined;
    }
    if (longPressFast) {
      clock.setRate(savedRateRef.current);
      setLongPressFast(false);
    }
  }, [clock, longPressFast]);

  const onStagePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.k-sub-line')) return;
      if (longPressTimerRef.current !== undefined) clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = setTimeout(() => {
        savedRateRef.current = clock.rate;
        clock.setRate(2);
        if (!clock.playing) clock.play();
        setLongPressFast(true);
      }, 450);
    },
    [clock],
  );

  const onStageDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.k-sub-line')) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const relX = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
      if (relX < 0.35) {
        prevRow();
        flashGestureToast('⏮ 上一句');
      } else if (relX > 0.65) {
        nextRow();
        flashGestureToast('⏭ 下一句');
      } else {
        videoRef.current?.parentElement?.requestFullscreen?.().catch(() => {});
      }
    },
    [prevRow, nextRow, flashGestureToast],
  );

  useEffect(
    () => () => {
      if (longPressTimerRef.current !== undefined) clearTimeout(longPressTimerRef.current);
      if (toastTimerRef.current !== undefined) clearTimeout(toastTimerRef.current);
    },
    [],
  );

  // Keyboard shortcuts (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          clock.toggle();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          prevRow();
          break;
        case 'ArrowRight':
          e.preventDefault();
          nextRow();
          break;
        case 'r':
        case 'R':
          toggleRepeatCue();
          break;
        case 'b':
        case 'B':
          setBlind((b) => !b);
          break;
        case 'Escape':
          if (useBreakdownStore.getState().isOpen) {
            closeBreakdown();
            setPanelTab('transcript');
          }
          break;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clock, prevRow, nextRow, toggleRepeatCue, closeBreakdown]);

  const transcript = (
    <TranscriptPanel
      rows={rows}
      activeRawIndexes={activeRaw}
      currentMs={clock.currentMs}
      selected={selected}
      onSelectedChange={setSelected}
      onSeek={jumpToRow}
      onCharClick={sb.openCue}
      onExplainSelection={(rs) => sb.openMerged(rs.map((r) => r.cue))}
      highlightFor={sb.highlightFor}
      cachedCueIndexes={preExplain.cachedCueIndexes}
      prefetchingCueIndexes={preExplain.prefetchingCueIndexes}
      t={t}
    />
  );

  const duration = clock.durationMs || episode.durationMs || 0;

  return (
    <div className={cx('k-player', expanded ? 'k-player--expanded' : 'k-player--compact')} data-testid="player">
      <div className="k-player__main">
        <header className="k-player__header">
          <IconButton icon="back" label={t('common.back')} onClick={() => useRouteStore.getState().goBack()} />
          <div className="k-player__title">
            <span className="k-title-medium" lang="ja" title={seriesQ.data?.title}>
              {formatAnimeSeriesTitle(seriesQ.data) || episode.parsedName.title || episode.title}
            </span>
            <span className="k-body-small k-muted" title={episode.fileName}>
              {episode.parsedName.episode !== undefined ? `#${episode.parsedName.episode} · ` : ''}
              {formatAnimeEpisodeTitle(episode, formatAnimeSeriesTitle(seriesQ.data))}
            </span>
          </div>
          <span className="k-spacer" />
          <SubtitleTrackMenu
            episode={episode}
            trackId={trackId}
            onSelectTrack={setTrackId}
            onTracksChanged={(id) => {
              reloadEpisode();
              if (id) setTrackId(id);
              setCuesNonce((n) => n + 1);
            }}
            t={t}
          />
          {expanded && <IconButton icon="list" label={t('player.transcript')} selected={panelOpen} onClick={() => setPanelOpen((o) => !o)} />}
        </header>

        <div
          className="k-player__stage"
          onDoubleClick={onStageDoubleClick}
          onPointerDown={onStagePointerDown}
          onPointerUp={endLongPress}
          onPointerLeave={endLongPress}
          onPointerCancel={endLongPress}
        >
          <video ref={videoRef} className="k-player__video" src={episode.mediaUrl} playsInline preload="metadata" onClick={clock.toggle} />
          {longPressFast && (
            <div className="k-player__speed-pill" data-testid="longpress-speed-badge">
              ⏩ 2.0× 倍速播放中
            </div>
          )}
          {gestureToast && (
            <div className="k-player__gesture-toast" data-testid="gesture-cue-toast">
              {gestureToast}
            </div>
          )}
          {clock.simulated && (
            <div className="k-player__sim">
              <Icon name="movie" size={48} />
              <span>{formatClock(clock.currentMs)}</span>
            </div>
          )}
          <SubtitleOverlay
            cues={cues}
            activeIndexes={sync.activeIndexes}
            mergeKaraoke={animeSettings.mergeKaraokeCues}
            blind={blind}
            onCharClick={onOverlayChar}
            highlightFor={sb.highlightFor}
            blindHint={t('player.blindHint')}
          />
        </div>
        {clock.simulated && <p className="k-player__notice">{t('player.mediaError')}</p>}

        <div className="k-player__controls">
          <input
            className="k-player__scrub"
            type="range"
            min={0}
            max={Math.max(1, duration)}
            step={100}
            value={Math.min(clock.currentMs, Math.max(1, duration))}
            aria-label="seek"
            onChange={(e) => clock.seek(Number(e.currentTarget.value))}
            style={{ ['--k-scrub-pct' as string]: `${duration ? (clock.currentMs / duration) * 100 : 0}%` }}
          />
          <div className="k-player__buttons">
            <IconButton icon="prev" label={t('player.prevCue')} onClick={prevRow} />
            <IconButton icon={clock.playing ? 'pause' : 'play'} variant="filled" label={clock.playing ? t('player.pause') : t('player.play')} onClick={clock.toggle} />
            <IconButton icon="next" label={t('player.nextCue')} onClick={nextRow} />
            <span className="k-player__time">
              {formatClock(clock.currentMs)} / {formatClock(duration)}
            </span>
            <span className="k-spacer" />
            <RepeatControls repeat={repeat} onToggleCue={toggleRepeatCue} onToggleAb={toggleAb} canAb={selected.size > 0} t={t} />
            <IconButton
              icon="sparkle"
              label={t('player.preExplain')}
              selected={Boolean(animeSettings.autoPreExplain)}
              data-testid="pre-explain-toggle"
              onClick={togglePreExplain}
            />
            <IconButton icon={blind ? 'visibilityOff' : 'visibility'} label={t('player.blind')} selected={blind} onClick={() => setBlind((b) => !b)} />
            <Menu
              items={[0.5, 0.75, 0.9, 1, 1.25, 1.5].map((r) => ({ key: String(r), label: `${r}×`, selected: clock.rate === r, onSelect: () => clock.setRate(r) }))}
              trigger={({ toggle }) => <IconButton icon="speed" label={`${t('player.speed')} ${clock.rate}×`} onClick={toggle} />}
            />
          </div>
          {expanded && <p className="k-player__hint k-body-small k-muted">{t('player.keyboardHint')}</p>}
        </div>

        {!expanded && <div className="k-player__compact-transcript">{transcript}</div>}
      </div>

      {expanded ? (
        <SideSheet
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
          width={440}
          closeLabel={t('common.close')}
          title={
            <Tabs<PanelTab>
              value={panelTab}
              onChange={setPanelTab}
              tabs={[
                { value: 'transcript', label: t('player.transcript'), icon: 'subtitles' },
                { value: 'breakdown', label: t('player.breakdown'), icon: 'sparkle' },
              ]}
            />
          }
        >
          <div {...sideSheetSwipe} style={{ height: '100%' }}>
            {panelTab === 'transcript' ? transcript : <BreakdownPanel />}
          </div>
        </SideSheet>
      ) : (
        <BottomSheet open={breakdownOpen} onClose={closeBreakdown} title={t('breakdown.title')} closeLabel={t('common.close')}>
          <BreakdownPanel />
        </BottomSheet>
      )}
    </div>
  );
}
