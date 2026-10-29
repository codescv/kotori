/**
 * Fullscreen & orientation state machine for the video player.
 *
 * Three strategies in priority order:
 * 1. `native`: Android Capacitor bridge (`host.screen.setImmersive`) — hides
 *    system bars and locks `SENSOR_LANDSCAPE` / restores `portrait-then-unlock`.
 * 2. `web`: Standard Fullscreen API (`el.requestFullscreen()`) + best-effort
 *    `screen.orientation.lock('landscape')`.
 * 3. `css`: Pure CSS fixed-inset fallback (jsdom / restricted WebViews).
 *
 * Physical phone rotation (`mobileLandscape`) enters `immersive` automatically
 * and hides system bars (`orientation: 'keep'`) without locking orientation.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ScreenApi } from '@kotori/core';

export type FullscreenMode = 'none' | 'native' | 'web' | 'css';

export interface FullscreenState {
  readonly mode: FullscreenMode;
  readonly fullscreen: boolean;
  readonly immersive: boolean;
  request(): void;
  exit(): void;
  toggle(): void;
}

interface WebScreenOrientation {
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
}

const getWebOrientation = (): WebScreenOrientation | undefined =>
  typeof window !== 'undefined' ? (window.screen?.orientation as WebScreenOrientation | undefined) : undefined;

export function useFullscreenState(
  playerRef: RefObject<HTMLElement | null>,
  screen: ScreenApi | undefined,
  mobileLandscape: boolean,
): FullscreenState {
  const [mode, setMode] = useState<FullscreenMode>('none');
  const barsHiddenRef = useRef(false);
  const orientationLockedRef = useRef(false);
  const requestedTokenRef = useRef(0);
  const screenRef = useRef(screen);
  screenRef.current = screen;

  const fullscreen = mode !== 'none';
  const immersive = fullscreen || mobileLandscape;

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onFullscreenChange = (): void => {
      if (document.fullscreenElement) {
        setMode((prev) => (prev === 'native' ? 'native' : 'web'));
      } else {
        setMode((prev) => (prev === 'web' ? 'none' : prev));
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const request = useCallback(() => {
    const token = ++requestedTokenRef.current;
    if (screen) {
      barsHiddenRef.current = true;
      orientationLockedRef.current = true;
      setMode('native');
      void screen.setImmersive({ immersive: true, orientation: 'landscape' }).catch(() => {});
      return;
    }
    const el = playerRef.current;
    if (el && typeof el.requestFullscreen === 'function') {
      setMode('web');
      try {
        const res = el.requestFullscreen();
        getWebOrientation()?.lock?.('landscape')?.catch(() => {});
        if (res && typeof res.then === 'function') {
          res.then(
            () => {
              if (requestedTokenRef.current === token) {
                setMode((prev) => (prev === 'none' ? 'none' : 'web'));
              }
            },
            () => {
              if (requestedTokenRef.current === token) {
                setMode((prev) => (prev === 'none' ? 'none' : 'css'));
              }
            },
          );
        }
      } catch {
        setMode('css');
      }
      return;
    }
    setMode('css');
  }, [playerRef, screen]);

  const exit = useCallback(() => {
    ++requestedTokenRef.current;
    if (screen) {
      barsHiddenRef.current = false;
      orientationLockedRef.current = false;
      setMode('none');
      void screen.setImmersive({ immersive: false, orientation: 'portrait-then-unlock' }).catch(() => {});
      return;
    }
    setMode('none');
    if (typeof document !== 'undefined' && document.fullscreenElement && typeof document.exitFullscreen === 'function') {
      void document.exitFullscreen().catch(() => {});
    }
    try {
      getWebOrientation()?.unlock?.();
    } catch {
      // Ignore unsupported unlock
    }
  }, [screen]);

  const toggle = useCallback(() => {
    if (fullscreen || (mobileLandscape && Boolean(screen))) {
      exit();
    } else {
      request();
    }
  }, [fullscreen, mobileLandscape, screen, exit, request]);

  // Sync system bars on physical rotation without duplicating IPC from request()/exit().
  useEffect(() => {
    if (!screen || barsHiddenRef.current === immersive) return;
    barsHiddenRef.current = immersive;
    void screen.setImmersive({ immersive, orientation: 'keep' }).catch(() => {});
  }, [immersive, screen]);

  // Unmount cleanup: restore orientation lock or hidden bars when leaving the player.
  useEffect(
    () => () => {
      if (orientationLockedRef.current) {
        orientationLockedRef.current = false;
        barsHiddenRef.current = false;
        void screenRef.current?.setImmersive({ immersive: false, orientation: 'portrait-then-unlock' }).catch(() => {});
      } else if (barsHiddenRef.current) {
        barsHiddenRef.current = false;
        void screenRef.current?.setImmersive({ immersive: false, orientation: 'keep' }).catch(() => {});
      }
    },
    [],
  );

  return { mode, fullscreen, immersive, request, exit, toggle };
}
