/**
 * Player clock + subtitle sync.
 *
 * `useMediaClock` wraps a `<video>` element: position updates come from
 * `requestVideoFrameCallback` when available (frame-accurate, no rAF loop),
 * else `timeupdate` + a rAF loop while playing. If the media cannot be decoded
 * (e.g. HEVC in Chromium, or the mock host's `mock://` URLs) it transparently
 * switches to a virtual wall-clock so subtitles, repeat and the breakdown stay
 * usable.
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

export function useMediaClock(videoRef: RefObject<HTMLVideoElement | null>, opts: { readonly durationHintMs?: number | undefined; readonly startMs?: number | undefined } = {}): MediaClock {
  const [currentMs, setCurrentMs] = useState(opts.startMs ?? 0);
  const [durationMs, setDurationMs] = useState(opts.durationHintMs ?? 0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRateState] = useState(1);
  const [simulated, setSimulated] = useState(false);
  // Virtual clock state (used when `simulated`).
  const virt = useRef({ base: opts.startMs ?? 0, since: 0, playing: false, rate: 1 });
  const simulatedRef = useRef(false);
  simulatedRef.current = simulated;

  // --- real element wiring ---------------------------------------------------
  useEffect(() => {
    const v = videoRef.current as VideoWithFrameCallback | null;
    if (!v) return;
    let raf = 0;
    let vfc = 0;
    const update = (): void => setCurrentMs(v.currentTime * 1000);
    const loop = (): void => {
      update();
      if (!v.paused) raf = requestAnimationFrame(loop);
    };
    const onFrame = (_now: number, meta: { mediaTime: number }): void => {
      setCurrentMs(meta.mediaTime * 1000);
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
  }, [simulated, playing, durationMs]);

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
      const target = Math.max(0, durationMs > 0 ? Math.min(ms, durationMs) : ms);
      if (simulatedRef.current) {
        virt.current = { ...virt.current, base: target, since: performance.now() };
        setCurrentMs(target);
        return;
      }
      const v = videoRef.current;
      if (v) v.currentTime = target / 1000;
      setCurrentMs(target);
    },
    [videoRef, durationMs],
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

  const toggle = useCallback(() => (playing ? pause() : play()), [playing, pause, play]);

  return { currentMs, durationMs, playing, rate, simulated, play, pause, toggle, seek, setRate };
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
  return { activeIndexes: activeRef.current, currentIndex, lastIndex: last.current };
}
