/**
 * Player clock + subtitle sync.
 *
 * `useMediaClock` wraps a `<video>` element: position updates come from
 * `requestVideoFrameCallback` when available (frame-accurate, no rAF loop),
 * else `timeupdate` + a rAF loop while playing. If the media cannot be decoded
 * (e.g. HEVC in Chromium, or the mock host's `mock://` URLs) it transparently
 * switches to a virtual wall-clock so subtitles, repeat and the breakdown stay
 * usable. Before giving up on a Kotori desktop-host stream (`http(s)://…/media/…`)
 * it retries once with `?compat=1`, which asks the host to serve an ffmpeg
 * MP4 remux (Safari / iOS cannot open MKV/AVI/TS containers).
 *
 * `usePlayerSync` derives the active cue(s) from the clock (`cueIndexAt`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { SubtitleCue } from '@kotori/core';
import { activeCueIndexes, cueIndexAt } from '../../../lib/cues';

export interface MediaClock {
  readonly currentMs: number;
  readonly durationMs: number;
  readonly playing: boolean;
  readonly rate: number;
  /** True when the element failed and a virtual clock drives playback. */
  readonly simulated: boolean;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(ms: number): void;
  setRate(rate: number): void;
}

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/**
 * The `?compat=1` retry URL for a failed `<video>` source, or `undefined` when
 * no retry applies (not an http(s) `/media/` URL, or already in compat mode).
 */
export function compatMediaRetryUrl(src: string | null | undefined): string | undefined {
  if (!src) return undefined;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (!url.pathname.includes('/media/') || url.searchParams.get('compat') === '1') return undefined;
  const hashAt = src.indexOf('#');
  const base = hashAt >= 0 ? src.slice(0, hashAt) : src;
  const hash = hashAt >= 0 ? src.slice(hashAt) : '';
  const sep = !base.includes('?') ? '?' : base.endsWith('?') || base.endsWith('&') ? '' : '&';
  return `${base}${sep}compat=1${hash}`;
}

/** Minimum interval between playback-driven `currentMs` state updates (~30 fps). */
export const CLOCK_TICK_MS = 33;
/** A position change larger than this (or any backwards move) is a jump and is published immediately. */
const CLOCK_JUMP_MS = 200;

/**
 * Whether a frame-driven position update should be published as React state:
 * at most every `CLOCK_TICK_MS` of wall time, except jumps (backwards or
 * `> CLOCK_JUMP_MS`) which are always published.
 */
export function shouldPublishClockTick(prevMs: number, nextMs: number, sinceLastPublishMs: number): boolean {
  if (nextMs < prevMs || nextMs - prevMs > CLOCK_JUMP_MS) return true;
  return sinceLastPublishMs >= CLOCK_TICK_MS;
}

export function useMediaClock(videoRef: RefObject<HTMLVideoElement | null>, opts: { readonly durationHintMs?: number | undefined; readonly startMs?: number | undefined } = {}): MediaClock {
  const [currentMs, setCurrentMsState] = useState(opts.startMs ?? 0);
  const [durationMs, setDurationMs] = useState(opts.durationHintMs ?? 0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRateState] = useState(1);
  const [simulated, setSimulated] = useState(false);
  // Virtual clock state (used when `simulated`).
  const virt = useRef({ base: opts.startMs ?? 0, since: 0, playing: false, rate: 1 });
  const simulatedRef = useRef(false);
  simulatedRef.current = simulated;
  // Refs so the control callbacks keep one identity for the player's lifetime.
  const durationMsRef = useRef(durationMs);
  durationMsRef.current = durationMs;
  const playingRef = useRef(playing);
  playingRef.current = playing;
  // Last published position + wall time (throttles per-frame updates).
  const publishedRef = useRef({ ms: opts.startMs ?? 0, at: -Infinity });

  /** Unthrottled publish (seek, pause, timeupdate, virtual clock). */
  const setCurrentMs = useCallback((ms: number) => {
    publishedRef.current = { ms, at: typeof performance !== 'undefined' ? performance.now() : Date.now() };
    setCurrentMsState(ms);
  }, []);

  // --- real element wiring ---------------------------------------------------
  useEffect(() => {
    const v = videoRef.current as VideoWithFrameCallback | null;
    if (!v) return;
    let raf = 0;
    let vfc = 0;
    const update = (): void => setCurrentMs(v.currentTime * 1000);
    /** Per-frame position (rAF / rVFC): throttled to ~30 fps unless it jumped. */
    const tick = (ms: number): void => {
      const now = performance.now();
      const last = publishedRef.current;
      if (shouldPublishClockTick(last.ms, ms, now - last.at)) setCurrentMs(ms);
    };
    const loop = (): void => {
      tick(v.currentTime * 1000);
      if (!v.paused) raf = requestAnimationFrame(loop);
    };
    const onFrame = (_now: number, meta: { mediaTime: number }): void => {
      tick(meta.mediaTime * 1000);
      vfc = v.requestVideoFrameCallback?.(onFrame) ?? 0;
    };
    const onPlay = (): void => {
      setPlaying(true);
      if (v.requestVideoFrameCallback) vfc = v.requestVideoFrameCallback(onFrame);
      else raf = requestAnimationFrame(loop);
    };
    const onPause = (): void => {
      setPlaying(false);
      cancelAnimationFrame(raf);
      if (vfc) v.cancelVideoFrameCallback?.(vfc);
      update();
    };
    const onMeta = (): void => {
      if (Number.isFinite(v.duration)) setDurationMs(v.duration * 1000);
      if (opts.startMs) v.currentTime = opts.startMs / 1000;
    };
    const onError = (): void => {
      if (simulatedRef.current) return;
      // Retry a host-node stream once as an ffmpeg-remuxed MP4 (`?compat=1`).
      const retry = compatMediaRetryUrl(v.currentSrc || v.src);
      if (retry) {
        v.src = retry;
        return;
      }
      virt.current = { base: v.currentTime * 1000 || (opts.startMs ?? 0), since: performance.now(), playing: false, rate: 1 };
      setSimulated(true);
    };
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('seeked', update);
    v.addEventListener('timeupdate', update);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('error', onError);
    if (v.error) onError();
    return () => {
      cancelAnimationFrame(raf);
      if (vfc) v.cancelVideoFrameCallback?.(vfc);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('seeked', update);
      v.removeEventListener('timeupdate', update);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('error', onError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef]);

  // --- virtual clock loop ------------------------------------------------------
  useEffect(() => {
    if (!simulated || !playing) return;
    const id = setInterval(() => {
      const s = virt.current;
      const now = s.base + (performance.now() - s.since) * s.rate;
      const capped = durationMs > 0 ? Math.min(now, durationMs) : now;
      setCurrentMs(capped);
      if (durationMs > 0 && now >= durationMs) {
        virt.current = { ...s, base: durationMs, since: performance.now(), playing: false };
        setPlaying(false);
      }
    }, 50);
    return () => clearInterval(id);
  }, [simulated, playing, durationMs, setCurrentMs]);

  const virtualNow = (): number => {
    const s = virt.current;
    return s.playing ? s.base + (performance.now() - s.since) * s.rate : s.base;
  };

  const play = useCallback(() => {
    if (simulatedRef.current) {
      virt.current = { ...virt.current, base: virtualNow(), since: performance.now(), playing: true };
      setPlaying(true);
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    const p = v.play();
    // jsdom / autoplay policies may reject; fall back to the virtual clock.
    if (p && typeof p.catch === 'function') {
      p.catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'NotAllowedError') return;
        virt.current = { base: v.currentTime * 1000, since: performance.now(), playing: true, rate: virt.current.rate };
        setSimulated(true);
        setPlaying(true);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef]);

  const pause = useCallback(() => {
    if (simulatedRef.current) {
      const now = virtualNow();
      virt.current = { ...virt.current, base: now, since: performance.now(), playing: false };
      setCurrentMs(now);
      setPlaying(false);
      return;
    }
    videoRef.current?.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef]);

  const seek = useCallback(
    (ms: number) => {
      const dur = durationMsRef.current;
      const target = Math.max(0, dur > 0 ? Math.min(ms, dur) : ms);
      if (simulatedRef.current) {
        virt.current = { ...virt.current, base: target, since: performance.now() };
        setCurrentMs(target);
        return;
      }
      const v = videoRef.current;
      if (v) v.currentTime = target / 1000;
      setCurrentMs(target);
    },
    [videoRef, setCurrentMs],
  );

  const setRate = useCallback(
    (r: number) => {
      setRateState(r);
      virt.current = { ...virt.current, base: virtualNow(), since: performance.now(), rate: r };
      if (videoRef.current) videoRef.current.playbackRate = r;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [videoRef],
  );

  const toggle = useCallback(() => (playingRef.current ? pause() : play()), [pause, play]);

  return useMemo(
    () => ({ currentMs, durationMs, playing, rate, simulated, play, pause, toggle, seek, setRate }),
    [currentMs, durationMs, playing, rate, simulated, play, pause, toggle, seek, setRate],
  );
}

export interface PlayerSync {
  /** Array positions of cues on screen now. */
  readonly activeIndexes: readonly number[];
  /** Array position of the current cue (`cueIndexAt`), -1 when between cues. */
  readonly currentIndex: number;
  /** Last cue that was current (sticky across gaps; for ←/→ and repeat). */
  readonly lastIndex: number;
}

export function usePlayerSync(cues: readonly SubtitleCue[], currentMs: number): PlayerSync {
  const currentIndex = useMemo(() => cueIndexAt(cues, currentMs), [cues, currentMs]);
  const activeKey = useRef<string>('');
  const activeRef = useRef<readonly number[]>([]);
  const next = activeCueIndexes(cues, currentMs);
  const key = next.join(',');
  // Keep referential stability while the active set does not change.
  if (key !== activeKey.current) {
    activeKey.current = key;
    activeRef.current = next;
  }
  const last = useRef(-1);
  if (currentIndex >= 0) last.current = currentIndex;
  const activeIndexes = activeRef.current;
  const lastIndex = last.current;
  return useMemo(() => ({ activeIndexes, currentIndex, lastIndex }), [activeIndexes, currentIndex, lastIndex]);
}
