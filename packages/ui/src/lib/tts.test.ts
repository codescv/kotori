import { afterEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_TTS_URL, speakJapanese } from './tts';

type W = Window & { Capacitor?: unknown; speechSynthesis?: unknown };

afterEach(() => {
  delete (window as W).Capacitor;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('speakJapanese', () => {
  it('prefers the native Android KotoriTorrent.speakText bridge', () => {
    const speakText = vi.fn().mockResolvedValue(undefined);
    (window as W).Capacitor = { isNativePlatform: () => true, Plugins: { KotoriTorrent: { speakText, stopSpeech: vi.fn() } } };
    expect(speakJapanese('  賭ける ', 0.8)).toBe(true);
    expect(speakText).toHaveBeenCalledWith({ text: '賭ける', lang: 'ja-JP', rate: 0.8 });
  });

  it('uses Web Speech when available (desktop browsers)', () => {
    const speak = vi.fn();
    const utterances: { text: string; lang?: string; rate?: number }[] = [];
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        lang = '';
        rate = 1;
        voice: unknown = null;
        constructor(public text: string) {
          utterances.push(this);
        }
      },
    );
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak, cancel: vi.fn(), getVoices: () => [{ lang: 'ja-JP' }] } });
    expect(speakJapanese('食べる')).toBe(true);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(utterances[0]).toMatchObject({ text: '食べる', lang: 'ja-JP', rate: 0.95 });
    delete (window as { speechSynthesis?: unknown }).speechSynthesis;
  });

  it('falls back to an <audio> element when speechSynthesis is missing', () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const urls: string[] = [];
    vi.stubGlobal(
      'Audio',
      class {
        playbackRate = 1;
        constructor(public src: string) {
          urls.push(src);
        }
        play = play;
        pause = vi.fn();
      },
    );
    expect('speechSynthesis' in window).toBe(false);
    expect(speakJapanese('かける')).toBe(true);
    expect(urls[0]).toBe(FALLBACK_TTS_URL + encodeURIComponent('かける'));
    expect(play).toHaveBeenCalled();
  });

  it('returns false for blank text', () => {
    expect(speakJapanese('   ')).toBe(false);
  });
});
