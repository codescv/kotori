/**
 * Floating auto-hide HUD overlay for `.k-player--immersive` (landscape phones &
 * desktop/tablet fullscreen). Rendered inside `.k-player__stage` right before
 * `<SubtitleOverlay />` so `.k-hud[data-visible="true"] ~ .k-sub-overlay` lifts
 * clickable subtitles cleanly above `.k-hud__bottom`.
 */
import { useEffect, useRef } from 'react';
import type { AnimeEpisode } from '@kotori/core';
import { cx } from '../../../components/m3/cx';
import { Icon } from '../../../components/m3/Icon';
import { IconButton } from '../../../components/m3/IconButton';
import { Menu } from '../../../components/m3/Menu';
import type { Translate } from '../../../i18n';
import { formatClock } from '../../../lib/cues';
import { RepeatControls, type RepeatApi } from './RepeatControls';
import { SubtitleTrackMenu, type TrackSelectionTarget } from './SubtitleTrackMenu';

export interface PlayerHudProps {
  readonly visible: boolean;
  readonly seriesTitle: string;
  readonly seriesRawTitle?: string | undefined;
  readonly episode: AnimeEpisode;
  readonly episodeTitle: string;
  readonly trackId: string | undefined;
  readonly secondaryTrackId: string | undefined;
  readonly onSelectTrack: (trackId: string) => void;
  readonly onSelectSecondaryTrack: (trackId: string | null) => void;
  readonly onTracksChanged: (select?: TrackSelectionTarget) => void;
  readonly drawerOpen: boolean;
  readonly onToggleDrawer: () => void;
  readonly onBack: () => void;
  readonly playing: boolean;
  readonly currentMs: number;
  readonly durationMs: number;
  readonly rate: number;
  readonly formatRate: (rate: number) => string;
  readonly onTogglePlay: () => void;
  readonly onPrevCue: () => void;
  readonly onNextCue: () => void;
  readonly onSeek: (ms: number) => void;
  readonly onScrubbingChange: (scrubbing: boolean) => void;
  readonly onSelectRate: (rate: number) => void;
  readonly repeat: RepeatApi;
  readonly onToggleRepeatCue: () => void;
  readonly onToggleAb: () => void;
  readonly canAb: boolean;
  readonly autoPreExplain: boolean;
  readonly onTogglePreExplain: () => void;
  readonly blind: boolean;
  readonly onToggleBlind: () => void;
  readonly canExitFullscreen: boolean;
  readonly onToggleFullscreen: () => void;
  readonly onActivity: () => void;
  readonly t: Translate;
}

const RATES = [0.5, 0.75, 0.9, 1, 1.25, 1.5] as const;

export function PlayerHud({
  visible,
  seriesTitle,
  seriesRawTitle,
  episode,
  episodeTitle,
  trackId,
  secondaryTrackId,
  onSelectTrack,
  onSelectSecondaryTrack,
  onTracksChanged,
  drawerOpen,
  onToggleDrawer,
  onBack,
  playing,
  currentMs,
  durationMs,
  rate,
  formatRate,
  onTogglePlay,
  onPrevCue,
  onNextCue,
  onSeek,
  onScrubbingChange,
  onSelectRate,
  repeat,
  onToggleRepeatCue,
  onToggleAb,
  canAb,
  autoPreExplain,
  onTogglePreExplain,
  blind,
  onToggleBlind,
  canExitFullscreen,
  onToggleFullscreen,
  onActivity,
  t,
}: PlayerHudProps) {
  const hudRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!visible && typeof document !== 'undefined' && hudRef.current?.contains(document.activeElement)) {
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
  }, [visible]);

  const maxDuration = Math.max(1, durationMs);
  return (
    <div
      ref={hudRef}
      className="k-hud"
      data-testid="player-hud"
      data-visible={visible ? 'true' : 'false'}
      aria-hidden={!visible}
      inert={!visible}
      onClick={onActivity}
    >
      <div className="k-hud__top">
        <IconButton icon="back" label={t('common.back')} onClick={onBack} />
        <div className="k-hud__title">
          <span className="k-hud__series" lang="ja" title={seriesRawTitle}>
            {seriesTitle}
          </span>
          <span className="k-hud__episode" title={episode.fileName}>
            {episode.parsedName.episode !== undefined ? `#${episode.parsedName.episode} · ` : ''}
            {episodeTitle}
          </span>
        </div>
        <span className="k-spacer" />
        <SubtitleTrackMenu
          episode={episode}
          trackId={trackId}
          secondaryTrackId={secondaryTrackId}
          onSelectTrack={onSelectTrack}
          onSelectSecondaryTrack={onSelectSecondaryTrack}
          onTracksChanged={onTracksChanged}
          t={t}
        />
        <IconButton
          icon="list"
          label={t('player.drawer')}
          selected={drawerOpen}
          data-testid="immersive-drawer-toggle"
          onClick={onToggleDrawer}
        />
      </div>

      <div className="k-hud__center">
        <IconButton icon="prev" label={t('player.prevCue')} className="k-hud__center-btn" onClick={onPrevCue} />
        <IconButton
          icon={playing ? 'pause' : 'play'}
          variant="filled"
          label={playing ? t('player.pause') : t('player.play')}
          title={`${playing ? t('player.pause') : t('player.play')} (Space)`}
          className="k-hud__play-btn"
          onClick={onTogglePlay}
        />
        <IconButton icon="next" label={t('player.nextCue')} className="k-hud__center-btn" onClick={onNextCue} />
      </div>

      <div className="k-hud__bottom">
        <input
          className="k-player__scrub"
          type="range"
          min={0}
          max={maxDuration}
          step={100}
          value={Math.min(currentMs, maxDuration)}
          aria-label="seek"
          onPointerDown={() => {
            onScrubbingChange(true);
            onActivity();
          }}
          onPointerUp={() => {
            onScrubbingChange(false);
            onActivity();
          }}
          onPointerCancel={() => onScrubbingChange(false)}
          onBlur={() => onScrubbingChange(false)}
          onChange={(e) => {
            onActivity();
            onSeek(Number(e.currentTarget.value));
          }}
          style={{ ['--k-scrub-pct' as string]: `${durationMs ? (currentMs / durationMs) * 100 : 0}%` }}
        />
        <div className="k-player__buttons">
          <span className="k-player__time" data-testid="player-time">
            {formatClock(currentMs)} / {formatClock(durationMs)}
          </span>
          <div className="k-player__spacer" />
          <RepeatControls repeat={repeat} onToggleCue={onToggleRepeatCue} onToggleAb={onToggleAb} canAb={canAb} t={t} />
          <IconButton
            icon="sparkle"
            label={t('player.preExplain')}
            selected={autoPreExplain}
            data-testid="pre-explain-toggle"
            onClick={onTogglePreExplain}
          />
          <IconButton
            icon={blind ? 'visibilityOff' : 'visibility'}
            label={t('player.blind')}
            selected={blind}
            data-testid="blind-toggle"
            onClick={onToggleBlind}
          />
          <Menu
            items={RATES.map((r) => ({ key: String(r), label: `${r}×`, selected: rate === r, onSelect: () => onSelectRate(r) }))}
            trigger={({ toggle }) => (
              <button
                type="button"
                className={cx('k-player__speed-btn', rate !== 1 && 'is-changed')}
                aria-label={`${t('player.speed')} ${rate}×`}
                title={`${t('player.speed')} ${rate}×`}
                data-testid="speed-button"
                onClick={toggle}
              >
                <Icon name="speed" size={18} />
                <span className="k-player__speed-label">{formatRate(rate)}</span>
              </button>
            )}
          />
          <IconButton
            icon={canExitFullscreen ? 'fullscreenExit' : 'fullscreen'}
            label={canExitFullscreen ? t('player.exitFullscreen') : t('player.fullscreen')}
            data-testid="fullscreen-toggle"
            onClick={onToggleFullscreen}
          />
        </div>
      </div>
    </div>
  );
}
