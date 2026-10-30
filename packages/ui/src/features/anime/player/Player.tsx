/**
 * Episode player: `<video>` + clickable primary subtitle (主字幕) + optional
 * smaller secondary translation subtitle (副字幕) + transcript / AI-breakdown
 * drawer (immersive full-bleed landscape/fullscreen with floating HUD + docked
 * side drawer, desktop expanded split-pane, phone portrait sheet).
 *
 * Keyboard: Space play/pause · ←/→ previous/next line · R repeat line ·
 * B hide/show subtitles · Esc close drawer / breakdown / fullscreen.
 *
 * Stage gestures: single tap toggles HUD (immersive) or play/pause (portrait /
 * expanded, deferred 240 ms so double-tap cancels it) · double-tap left/right
 * 35 % previous/next line · double-tap centre play/pause (immersive) or
 * fullscreen (portrait / expanded) · long-press 2× speed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnimeEpisode, SubtitleCue, SubtitleTrack, TranscriptRow } from '@kotori/core';
import { BreakdownPanel, type AudioSliceReplay } from '../../../components/breakdown/AiBreakdownPanel';
import { cx } from '../../../components/m3/cx';
import { Icon } from '../../../components/m3/Icon';
import { IconButton } from '../../../components/m3/IconButton';
import { Menu } from '../../../components/m3/Menu';
import { CircularProgress } from '../../../components/m3/Progress';
import { BottomSheet, SideSheet } from '../../../components/m3/Sheet';
import { Tabs, useTabSwipe } from '../../../components/m3/Tabs';
import { useHost } from '../../../host/HostContext';
import { useAsync } from '../../../host/useAsync';
import { useIsExpanded, useIsMobileLandscape } from '../../../hooks/useMediaQuery';
import { useT } from '../../../i18n';
import {
  buildTranscriptRows,
  formatAnimeEpisodeTitle,
  formatAnimeSeriesTitle,
  formatClock,
  isBilingualTrack,
  matchSecondaryCuesToRows,
} from '../../../lib/cues';
import { useBackInterceptor, useRouteStore } from '../../../app/routes';
import { useBreakdownStore } from '../../../stores/breakdown';
import { useSettingsStore } from '../../../stores/settings';
import { showSnackbar } from '../../../stores/snackbar';
import { PlayerHud } from './PlayerHud';
import { RepeatControls, useRepeat } from './RepeatControls';
import {
  DEFAULT_SECONDARY_LANGS,
  resolveSecondaryTrackId,
  trackLanguage,
  type SecondaryChoice,
} from './secondaryTrack';
import { SubtitleOverlay } from './SubtitleOverlay';
import { formatSubtitleTrackLabel, SubtitleTrackMenu, type TrackSelectionTarget } from './SubtitleTrackMenu';
import { activeRowIndex, TranscriptPanel } from './TranscriptPanel';
import { useFullscreenState } from './useFullscreenState';
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
const RATES = [0.5, 0.75, 0.9, 1, 1.25, 1.5] as const;

/** `1×`, `0.75×`, `1.25×` — compact playback-rate label for the speed button. */
export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}

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
  const mobileLandscape = useIsMobileLandscape();
  const playerRef = useRef<HTMLDivElement>(null);
  const { fullscreen, immersive, exit: exitFullscreen, toggle: toggleFullscreen } = useFullscreenState(
    playerRef,
    host.screen,
    mobileLandscape,
  );
  const layout: 'immersive' | 'expanded' | 'portrait' = immersive ? 'immersive' : expanded ? 'expanded' : 'portrait';

  const animeSettings = useSettingsStore((s) => s.settings.anime);
  const updateSettings = useSettingsStore((s) => s.update);
  const episodeId = episode.id;

  const seriesQ = useAsync(() => host.anime.getSeries(seriesId), [host, seriesId]);
  const [trackId, setTrackId] = useState<string | undefined>(() => pickDefaultTrack(episode, animeSettings.preferredSubtitleLanguages)?.id);
  const [secondaryChoice, setSecondaryChoice] = useState<SecondaryChoice>({ kind: 'auto' });
  const prevEpisodeIdRef = useRef(episodeId);
  if (prevEpisodeIdRef.current !== episodeId) {
    prevEpisodeIdRef.current = episodeId;
    setSecondaryChoice({ kind: 'auto' });
  }
  useEffect(() => {
    if (!trackId || !episode.subtitleTracks.some((x) => x.id === trackId)) {
      setTrackId(pickDefaultTrack(episode, animeSettings.preferredSubtitleLanguages)?.id);
    }
  }, [episode, trackId, animeSettings.preferredSubtitleLanguages]);
  const [cuesNonce, setCuesNonce] = useState(0);
  const cuesQ = useAsync(
    async () => (trackId ? { forTrackId: trackId, parsed: await host.anime.getCues(trackId) } : undefined),
    [host, trackId, cuesNonce],
  );
  const cues = cuesQ.data?.parsed.cues ?? EMPTY_CUES;

  const videoRef = useRef<HTMLVideoElement>(null);
  const clock = useMediaClock(videoRef, { durationHintMs: episode.durationMs, startMs: episode.progress?.positionMs });
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const sync = usePlayerSync(cues, clock.currentMs);
  const rows = useMemo(() => buildTranscriptRows(cues, { mergeKaraoke: animeSettings.mergeKaraokeCues, hideSigns: animeSettings.hideSigns }), [cues, animeSettings.mergeKaraokeCues, animeSettings.hideSigns]);
  const activeRaw = useMemo(() => new Set(sync.activeIndexes.map((i) => cues[i]?.index ?? -1)), [sync.activeIndexes, cues]);
  const rowCues = useMemo(() => rows.map((r) => r.cue), [rows]);

  const preferredSecondary = animeSettings.preferredSecondarySubtitleLanguages ?? DEFAULT_SECONDARY_LANGS;
  const secondaryMode = animeSettings.secondarySubtitle ?? 'auto';
  const primaryIsBilingual: boolean | undefined = !trackId
    ? false
    : cuesQ.loading || (cuesQ.data?.forTrackId !== trackId && !cuesQ.error)
      ? undefined
      : isBilingualTrack(rowCues);

  const secondaryTrackId = useMemo(
    () =>
      resolveSecondaryTrackId(episode, trackId, secondaryChoice, {
        preferred: preferredSecondary,
        mode: secondaryMode,
        primaryIsBilingual,
      }),
    [episode, trackId, secondaryChoice, preferredSecondary, secondaryMode, primaryIsBilingual],
  );
  const secondaryTrack = useMemo(
    () => (secondaryTrackId ? episode.subtitleTracks.find((x) => x.id === secondaryTrackId) : undefined),
    [episode.subtitleTracks, secondaryTrackId],
  );
  const secondaryCuesQ = useAsync(
    async () => (secondaryTrackId ? { forTrackId: secondaryTrackId, parsed: await host.anime.getCues(secondaryTrackId) } : undefined),
    [host, secondaryTrackId, cuesNonce],
  );
  useEffect(() => {
    if (secondaryCuesQ.error) {
      showSnackbar(t('player.secondaryLoadFailed', { message: secondaryCuesQ.error.message }), { tone: 'error' });
    }
  }, [secondaryCuesQ.error, t]);
  const secondaryCues =
    secondaryTrackId && !secondaryCuesQ.error && secondaryCuesQ.data?.parsed
      ? secondaryCuesQ.data.parsed.cues
      : EMPTY_CUES;
  const secondarySync = usePlayerSync(secondaryCues, clock.currentMs);
  const secondaryLang = secondaryTrack ? trackLanguage(secondaryTrack) : undefined;
  const secondaryTextByRep = useMemo(
    () => (secondaryCues.length > 0 ? matchSecondaryCuesToRows(rows, secondaryCues) : undefined),
    [rows, secondaryCues],
  );

  const sb = useSubtitleBreakdown({ episodeId, trackId, contextCues: rowCues, sceneHint: seriesQ.data?.title });

  const [blind, setBlind] = useState(false);
  const [expandedPanelOpen, setExpandedPanelOpen] = useState(true);
  const [immersiveDrawerOpen, setImmersiveDrawerOpen] = useState(() => useBreakdownStore.getState().isOpen);
  const [panelTab, setPanelTab] = useState<PanelTab>('transcript');
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [pauseAt, setPauseAt] = useState<number | undefined>(undefined);
  const [hudVisible, setHudVisible] = useState(true);
  const [hudNonce, setHudNonce] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);

  const immersiveRef = useRef(immersive);
  immersiveRef.current = immersive;
  const hudVisibleRef = useRef(hudVisible);
  hudVisibleRef.current = hudVisible;
  const lastMouseWakeAtRef = useRef(-Infinity);

  const repeat = useRepeat(clock.currentMs, clock.seek, animeSettings.seekPaddingMs);
  const breakdownOpen = useBreakdownStore((s) => s.isOpen);
  const breakdownRequest = useBreakdownStore((s) => s.request);
  const closeBreakdown = useBreakdownStore((s) => s.close);
  const explainedAtMsRef = useRef<number | undefined>(undefined);
  const prevBreakdownRequestRef = useRef(breakdownRequest);
  if (breakdownRequest !== prevBreakdownRequestRef.current) {
    prevBreakdownRequestRef.current = breakdownRequest;
    explainedAtMsRef.current = breakdownRequest ? clock.currentMs : undefined;
  }
  const sideSheetSwipe = useTabSwipe<PanelTab>(['transcript', 'breakdown'], panelTab, setPanelTab);

  const bumpHudTimer = useCallback(() => {
    setHudNonce((n) => n + 1);
  }, []);

  const wakeHud = useCallback(() => {
    hudVisibleRef.current = true;
    setHudVisible(true);
    setHudNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!immersive) {
      hudVisibleRef.current = true;
      setHudVisible(true);
      setScrubbing(false);
    }
  }, [immersive]);

  useEffect(() => {
    if (!scrubbing) return;
    const stop = (): void => setScrubbing(false);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [scrubbing]);

  // Auto-hide HUD after 3500 ms when playing or when the learning drawer is open;
  // stay pinned when paused with the drawer closed unless manually tapped away.
  useEffect(() => {
    if (!immersive || !hudVisible) return;
    if ((!clock.playing && !immersiveDrawerOpen) || scrubbing) return;
    const id = setTimeout(() => {
      const menuOpen = Boolean(playerRef.current?.querySelector('[role="menu"]'));
      const dialogOpen = typeof document !== 'undefined' && Boolean(document.querySelector('.k-dialog-scrim'));
      if (!menuOpen && !dialogOpen) {
        hudVisibleRef.current = false;
        setHudVisible(false);
      } else {
        setHudNonce((n) => n + 1);
      }
    }, 3500);
    return () => clearTimeout(id);
  }, [immersive, hudVisible, hudNonce, clock.playing, immersiveDrawerOpen, scrubbing]);

  const closeImmersiveDrawer = useCallback(() => {
    closeBreakdown();
    setImmersiveDrawerOpen(false);
  }, [closeBreakdown]);

  const toggleImmersiveDrawer = useCallback(() => {
    setImmersiveDrawerOpen((open) => {
      if (open) {
        closeBreakdown();
      } else if (!useBreakdownStore.getState().isOpen) {
        setPanelTab('transcript');
      }
      return !open;
    });
  }, [closeBreakdown]);

  useBackInterceptor(() => {
    const bdOpen = useBreakdownStore.getState().isOpen;
    if (immersive && (immersiveDrawerOpen || bdOpen)) {
      closeBreakdown();
      setImmersiveDrawerOpen(false);
      return true;
    }
    if (!immersive && bdOpen) {
      closeBreakdown();
      setPanelTab('transcript');
      return true;
    }
    if (fullscreen) {
      exitFullscreen();
      return true;
    }
    return false;
  });

  // Opening a breakdown brings its tab forward (expanded / immersive) or its sheet up (portrait).
  // Any new request (e.g. 合并解析 from the transcript tab while the panel is
  // already open) also switches to the AI tab.
  useEffect(() => {
    if (breakdownOpen) {
      setExpandedPanelOpen(true);
      setImmersiveDrawerOpen(true);
      setPanelTab('breakdown');
    }
  }, [breakdownOpen]);
  useEffect(() => {
    if (breakdownRequest) {
      setExpandedPanelOpen(true);
      setImmersiveDrawerOpen(true);
      setPanelTab('breakdown');
    }
  }, [breakdownRequest]);
  useEffect(() => {
    if (immersive && breakdownOpen) {
      setImmersiveDrawerOpen(true);
    }
  }, [immersive, breakdownOpen]);
  useEffect(() => () => useBreakdownStore.getState().close(), []);

  // Register audio slice replay handler for the AI Breakdown panel (`🔊 原声`,
  // `🐢 0.75×`, `🗣 跟读`). The optional `rate` is applied for the slice only and
  // the previous playback rate is restored when it pauses at the slice end.
  const restoreRateRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const setHandler = useBreakdownStore.getState().setAudioReplayHandler;
    const replay: AudioSliceReplay = (startMs, endMs, rate) => {
      const c = clockRef.current;
      if (rate !== undefined) {
        if (restoreRateRef.current === undefined) restoreRateRef.current = c.rate;
        if (rate !== c.rate) c.setRate(rate);
      }
      c.seek(Math.max(0, startMs - 80));
      setPauseAt(Math.max(startMs + 250, endMs + 120));
      c.play();
    };
    setHandler(replay);
    return () => setHandler(undefined);
  }, []);

  // Pause at the end of a line after a jump (AnimeSettings.pauseAfterJump).
  useEffect(() => {
    if (pauseAt !== undefined && clock.currentMs >= pauseAt) {
      clock.pause();
      setPauseAt(undefined);
      if (restoreRateRef.current !== undefined) {
        clock.setRate(restoreRateRef.current);
        restoreRateRef.current = undefined;
      }
    }
  }, [clock, pauseAt]);

  // Hide-subtitles feedback (skip the initial mount).
  const blindMountedRef = useRef(false);
  useEffect(() => {
    if (!blindMountedRef.current) {
      blindMountedRef.current = true;
      return;
    }
    showSnackbar(blind ? '已隐藏视频字幕' : '已显示视频字幕');
  }, [blind]);

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
      if (immersiveRef.current) {
        hudVisibleRef.current = false;
        setHudVisible(false);
      }
      sb.openCue(cue, i);
    },
    [clock, sb],
  );
  // Transcript char click behaves like the overlay (pause) unless disabled in settings.
  const pauseOnTranscriptClick = animeSettings.pauseOnTranscriptClick !== false;
  const onTranscriptChar = useCallback(
    (cue: SubtitleCue, i: number) => {
      if (pauseOnTranscriptClick) clock.pause();
      sb.openCue(cue, i);
    },
    [clock, sb, pauseOnTranscriptClick],
  );

  const onSelectSecondaryTrack = useCallback(
    (id: string | null) => {
      if (id === null) {
        setSecondaryChoice({ kind: 'off' });
        void updateSettings(host, { anime: { secondarySubtitle: 'off' } });
        showSnackbar(t('player.secondaryOffDone'));
        return;
      }
      setSecondaryChoice({ kind: 'track', id });
      const chosen = episode.subtitleTracks.find((x) => x.id === id);
      const lang = chosen ? trackLanguage(chosen) : undefined;
      if (lang) {
        const nextLangs = [lang, ...preferredSecondary.filter((l) => l !== lang)];
        void updateSettings(host, {
          anime: {
            secondarySubtitle: 'auto',
            preferredSecondarySubtitleLanguages: nextLangs,
          },
        });
      }
      showSnackbar(t('player.secondaryOn', { label: chosen ? formatSubtitleTrackLabel(chosen, episode) : id }));
    },
    [episode, preferredSecondary, updateSettings, host, t],
  );

  const onTracksChanged = useCallback(
    (select?: TrackSelectionTarget) => {
      reloadEpisode();
      if (select?.primary) setTrackId(select.primary);
      if (select?.secondary) setSecondaryChoice({ kind: 'track', id: select.secondary });
      setCuesNonce((n) => n + 1);
    },
    [reloadEpisode],
  );

  // Touch & pointer precision listening gestures:
  // - Long-press (450 ms) on video stage -> temporary 2.0x speed
  // - Double-tap / double-click left 35% -> prevRow, right 35% -> nextRow,
  //   center 30% -> play/pause (immersive) or fullscreen (portrait / expanded)
  const [longPressFast, setLongPressFast] = useState(false);
  const [gestureToast, setGestureToast] = useState<string | undefined>(undefined);
  const savedRateRef = useRef<number>(1);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tapTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressClickRef = useRef(false);

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
      // The release of a long-press must not also toggle play/pause or HUD.
      suppressClickRef.current = true;
    }
  }, [clock, longPressFast]);

  const clearTapTimer = useCallback(() => {
    if (tapTimerRef.current !== undefined) {
      clearTimeout(tapTimerRef.current);
      tapTimerRef.current = undefined;
    }
  }, []);

  // Single tap → toggle HUD (immersive) or play/pause (portrait/expanded) after
  // 240 ms; a second tap (double-tap / dblclick) cancels it cleanly.
  const onVideoClick = useCallback(
    (e: React.MouseEvent<HTMLVideoElement>) => {
      clearTapTimer();
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        return;
      }
      if (e.detail >= 2) return;
      const clickedAt = performance.now();
      tapTimerRef.current = setTimeout(() => {
        tapTimerRef.current = undefined;
        if (immersiveRef.current) {
          if (clickedAt - lastMouseWakeAtRef.current < 350) {
            lastMouseWakeAtRef.current = -Infinity;
            hudVisibleRef.current = true;
            setHudVisible(true);
            setHudNonce((n) => n + 1);
            return;
          }
          setHudVisible((v) => {
            const next = !v;
            hudVisibleRef.current = next;
            if (next) setHudNonce((n) => n + 1);
            return next;
          });
        } else {
          clockRef.current.toggle();
        }
      }, 240);
    },
    [clearTapTimer],
  );

  const onStagePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!immersiveRef.current || e.pointerType !== 'mouse') return;
      const dx = e.movementX || 0;
      const dy = e.movementY || 0;
      if (Math.hypot(dx, dy) < 2) return;
      const target = e.target as HTMLElement | null;
      if (!hudVisibleRef.current && target?.closest('.k-sub-line')) return;
      if (!hudVisibleRef.current) {
        lastMouseWakeAtRef.current = performance.now();
      }
      wakeHud();
    },
    [wakeHud],
  );

  const onStagePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.k-sub-line, button, input, .k-menu, .k-menu-anchor')) return;
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
      if (target?.closest('.k-sub-line, button, input, .k-menu, .k-menu-anchor')) return;
      clearTapTimer();
      const rect = e.currentTarget.getBoundingClientRect();
      const relX = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0.5;
      if (relX < 0.35) {
        prevRow();
        flashGestureToast('⏮ 上一句');
      } else if (relX > 0.65) {
        nextRow();
        flashGestureToast('⏭ 下一句');
      } else if (immersive) {
        clock.toggle();
        flashGestureToast(clock.playing ? '⏸' : '▶');
      } else {
        toggleFullscreen();
      }
    },
    [prevRow, nextRow, flashGestureToast, clearTapTimer, immersive, clock, toggleFullscreen],
  );

  useEffect(
    () => () => {
      if (longPressTimerRef.current !== undefined) clearTimeout(longPressTimerRef.current);
      if (toastTimerRef.current !== undefined) clearTimeout(toastTimerRef.current);
      if (tapTimerRef.current !== undefined) clearTimeout(tapTimerRef.current);
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
          if (immersiveRef.current) bumpHudTimer();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          prevRow();
          if (immersiveRef.current) bumpHudTimer();
          break;
        case 'ArrowRight':
          e.preventDefault();
          nextRow();
          if (immersiveRef.current) bumpHudTimer();
          break;
        case 'r':
        case 'R':
          toggleRepeatCue();
          if (immersiveRef.current) bumpHudTimer();
          break;
        case 'b':
        case 'B':
          setBlind((b) => !b);
          if (immersiveRef.current) bumpHudTimer();
          break;
        case 'Escape': {
          const bdOpen = useBreakdownStore.getState().isOpen;
          if (immersive && (immersiveDrawerOpen || bdOpen)) {
            closeBreakdown();
            setImmersiveDrawerOpen(false);
          } else if (bdOpen) {
            closeBreakdown();
            setPanelTab('transcript');
          } else if (fullscreen) {
            exitFullscreen();
          }
          break;
        }
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clock, prevRow, nextRow, toggleRepeatCue, closeBreakdown, bumpHudTimer, immersive, immersiveDrawerOpen, fullscreen, exitFullscreen]);

  const preferExplainingOnMount =
    (explainedAtMsRef.current !== undefined && Math.abs(clock.currentMs - explainedAtMsRef.current) < 500) ||
    (sb.source !== undefined && clock.currentMs >= sb.source.startMs - 500 && clock.currentMs <= sb.source.endMs + 500);

  const transcript = (
    <TranscriptPanel
      rows={rows}
      activeRawIndexes={activeRaw}
      currentMs={clock.currentMs}
      selected={selected}
      onSelectedChange={setSelected}
      onSeek={jumpToRow}
      onCharClick={onTranscriptChar}
      onExplainSelection={(rs) => sb.openMerged(rs.map((r) => r.cue))}
      highlightFor={sb.highlightFor}
      cachedCueIndexes={preExplain.cachedCueIndexes}
      prefetchingCueIndexes={preExplain.prefetchingCueIndexes}
      secondaryTextByRep={secondaryTextByRep}
      preferExplainingOnMount={preferExplainingOnMount}
      t={t}
    />
  );

  const duration = clock.durationMs || episode.durationMs || 0;
  const formattedSeriesTitle = formatAnimeSeriesTitle(seriesQ.data);
  const seriesTitle = formattedSeriesTitle || episode.parsedName.title || episode.title;
  const episodeTitle = formatAnimeEpisodeTitle(episode, formattedSeriesTitle);

  return (
    <div
      ref={playerRef}
      className={cx(
        'k-player',
        layout === 'immersive' ? 'k-player--immersive' : layout === 'expanded' ? 'k-player--expanded' : 'k-player--compact',
        layout === 'immersive' && immersiveDrawerOpen && 'is-drawer-open',
      )}
      data-testid="player"
    >
      <div className="k-player__main">
        {layout !== 'immersive' && (
          <header className="k-player__header">
            <IconButton icon="back" label={t('common.back')} onClick={() => useRouteStore.getState().goBack()} />
            <div className="k-player__title">
              <span className="k-title-medium" lang="ja" title={seriesQ.data?.title}>
                {seriesTitle}
              </span>
              <span className="k-body-small k-muted" title={episode.fileName}>
                {episode.parsedName.episode !== undefined ? `#${episode.parsedName.episode} · ` : ''}
                {episodeTitle}
              </span>
            </div>
            <span className="k-spacer" />
            <SubtitleTrackMenu
              episode={episode}
              trackId={trackId}
              secondaryTrackId={secondaryTrackId}
              onSelectTrack={setTrackId}
              onSelectSecondaryTrack={onSelectSecondaryTrack}
              onTracksChanged={onTracksChanged}
              t={t}
            />
            {layout === 'expanded' && (
              <IconButton icon="list" label={t('player.transcript')} selected={expandedPanelOpen} onClick={() => setExpandedPanelOpen((o) => !o)} />
            )}
          </header>
        )}

        <div
          className="k-player__stage"
          onDoubleClick={onStageDoubleClick}
          onPointerMove={onStagePointerMove}
          onPointerDown={onStagePointerDown}
          onPointerUp={endLongPress}
          onPointerLeave={endLongPress}
          onPointerCancel={endLongPress}
        >
          <video
            ref={videoRef}
            className="k-player__video"
            src={episode.mediaUrl}
            playsInline
            preload="metadata"
            aria-label={immersive ? t(hudVisible ? 'player.hideControls' : 'player.showControls') : undefined}
            onClick={onVideoClick}
          />
          {immersive && (
            <PlayerHud
              visible={hudVisible}
              seriesTitle={seriesTitle}
              seriesRawTitle={seriesQ.data?.title}
              episode={episode}
              episodeTitle={episodeTitle}
              trackId={trackId}
              secondaryTrackId={secondaryTrackId}
              onSelectTrack={setTrackId}
              onSelectSecondaryTrack={onSelectSecondaryTrack}
              onTracksChanged={onTracksChanged}
              drawerOpen={immersiveDrawerOpen}
              onToggleDrawer={toggleImmersiveDrawer}
              onBack={() => useRouteStore.getState().goBack()}
              playing={clock.playing}
              currentMs={clock.currentMs}
              durationMs={duration}
              rate={clock.rate}
              formatRate={formatRate}
              onTogglePlay={clock.toggle}
              onPrevCue={prevRow}
              onNextCue={nextRow}
              onSeek={clock.seek}
              onScrubbingChange={setScrubbing}
              onSelectRate={clock.setRate}
              repeat={repeat}
              onToggleRepeatCue={toggleRepeatCue}
              onToggleAb={toggleAb}
              canAb={selected.size > 0}
              autoPreExplain={Boolean(animeSettings.autoPreExplain)}
              onTogglePreExplain={togglePreExplain}
              blind={blind}
              onToggleBlind={() => setBlind((b) => !b)}
              canExitFullscreen={fullscreen || Boolean(host.screen)}
              onToggleFullscreen={toggleFullscreen}
              onActivity={wakeHud}
              t={t}
            />
          )}
          {blind && (
            <div className="k-player__subs-hidden" data-testid="subs-hidden-badge" aria-live="polite">
              <Icon name="visibilityOff" size={14} /> 已隐藏视频字幕
            </div>
          )}
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
            secondaryCues={secondaryCues}
            secondaryActiveIndexes={secondarySync.activeIndexes}
            secondaryLang={secondaryLang}
          />
        </div>
        {layout !== 'immersive' && clock.simulated && <p className="k-player__notice">{t('player.mediaError')}</p>}

        {layout !== 'immersive' && (
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
              <IconButton
                icon={clock.playing ? 'pause' : 'play'}
                variant="filled"
                label={clock.playing ? t('player.pause') : t('player.play')}
                title={`${clock.playing ? t('player.pause') : t('player.play')} (Space)`}
                onClick={clock.toggle}
              />
              <IconButton icon="next" label={t('player.nextCue')} onClick={nextRow} />
              <span className="k-player__time" data-testid="player-time">
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
              <IconButton
                icon={blind ? 'visibilityOff' : 'visibility'}
                label={t('player.blind')}
                selected={blind}
                data-testid="blind-toggle"
                onClick={() => setBlind((b) => !b)}
              />
              <Menu
                items={RATES.map((r) => ({ key: String(r), label: `${r}×`, selected: clock.rate === r, onSelect: () => clock.setRate(r) }))}
                trigger={({ toggle }) => (
                  <button
                    type="button"
                    className={cx('k-player__speed-btn', clock.rate !== 1 && 'is-changed')}
                    aria-label={`${t('player.speed')} ${clock.rate}×`}
                    title={`${t('player.speed')} ${clock.rate}×`}
                    data-testid="speed-button"
                    onClick={toggle}
                  >
                    <Icon name="speed" size={18} />
                    <span className="k-player__speed-label">{formatRate(clock.rate)}</span>
                  </button>
                )}
              />
              <IconButton
                icon="fullscreen"
                label={t('player.fullscreen')}
                data-testid="fullscreen-toggle"
                onClick={toggleFullscreen}
              />
            </div>
          </div>
        )}

        {layout === 'portrait' && <div className="k-player__compact-transcript">{transcript}</div>}
      </div>

      {layout === 'portrait' ? (
        <BottomSheet open={breakdownOpen} onClose={closeBreakdown} title={t('breakdown.title')} closeLabel={t('common.close')}>
          <BreakdownPanel />
        </BottomSheet>
      ) : (
        <SideSheet
          className="k-player__drawer"
          open={layout === 'immersive' ? immersiveDrawerOpen : expandedPanelOpen}
          onClose={layout === 'immersive' ? closeImmersiveDrawer : () => setExpandedPanelOpen(false)}
          width={expanded ? 440 : undefined}
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
          <div {...sideSheetSwipe} style={{ minHeight: '100%' }}>
            {panelTab === 'transcript' ? transcript : <BreakdownPanel />}
          </div>
        </SideSheet>
      )}
    </div>
  );
}
