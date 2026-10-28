/**
 * Cross-platform Japanese TTS helper, used for one-click sentence &
 * vocabulary pronunciation in the AI Breakdown panel (especially for manga
 * bubbles where there is no audio track).
 *
 * Resolution order:
 *   1. Native Android Capacitor plugin (`KotoriTorrent.speakText`) — Android
 *      System WebView does not implement `window.speechSynthesis`.
 *   2. Web Speech API (`window.speechSynthesis`) when it is usable (voices
 *      present, or not an Android WebView where the API is a silent stub).
 *   3. HTML5 `<audio>` fallback streaming Google Translate TTS.
 */

/** Shape of the native bridge exposed by `@kotori/host-android`'s `KotoriTorrent` plugin. */
interface NativeTtsPlugin {
  speakText?: (opts: { text: string; lang: string; rate: number }) => Promise<unknown> | unknown;
  stopSpeech?: () => Promise<unknown> | unknown;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: { KotoriTorrent?: NativeTtsPlugin };
}

/** Google Translate TTS endpoint used by the `<audio>` fallback. */
export const FALLBACK_TTS_URL = 'https://translate.googleapis.com/translate_tts?ie=UTF-8&client=tw-ob&tl=ja&q=';

let fallbackAudio: HTMLAudioElement | undefined;

function nativePlugin(): NativeTtsPlugin | undefined {
  if (typeof window === 'undefined') return undefined;
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  const plugin = cap?.Plugins?.KotoriTorrent;
  return plugin && typeof plugin.speakText === 'function' ? plugin : undefined;
}

/** Android System WebView (`; wv)` UA token) — its `speechSynthesis`, when present, is usually a voiceless stub. */
function isAndroidWebView(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /Android/i.test(ua) && (/; wv\)/i.test(ua) || /Version\/[\d.]+ Chrome\//i.test(ua));
}

function speakWithAudio(text: string, rate: number): boolean {
  if (typeof Audio === 'undefined') return false;
  try {
    fallbackAudio?.pause();
    const audio = new Audio(FALLBACK_TTS_URL + encodeURIComponent(text));
    audio.playbackRate = rate;
    fallbackAudio = audio;
    const played = audio.play();
    if (played && typeof (played as Promise<void>).catch === 'function') (played as Promise<void>).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Speak `text` in Japanese. Returns `true` when playback was started by one
 * of the backends (native plugin → Web Speech → `<audio>` fallback).
 *
 * Defaults to `rate = 1` so Android `MediaPlayer` uses direct PCM output
 * without routing short single-word MP3s through the Sonic time-stretch buffer.
 */
export function speakJapanese(text: string, rate = 1): boolean {
  const cleaned = text.trim();
  if (!cleaned) return false;
  if (typeof window === 'undefined') return false;

  // 1. Native Android TTS bridge.
  const plugin = nativePlugin();
  if (plugin?.speakText) {
    try {
      const r = plugin.speakText({ text: cleaned, lang: 'ja-JP', rate });
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        (r as Promise<unknown>).then(
          (res) => {
            if (res && typeof res === 'object' && 'ok' in res && (res as { ok?: unknown }).ok === false) {
              const reason = (res as { reason?: unknown }).reason;
              if (reason !== 'superseded') {
                speakWithAudio(cleaned, rate);
              }
            }
          },
          () => {
            speakWithAudio(cleaned, rate);
          },
        );
      }
      return true;
    } catch {
      // fall through to the web backends
    }
  }

  // 2. Web Speech API.
  const hasSynth = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  if (hasSynth) {
    try {
      const synth = window.speechSynthesis;
      const voices = synth.getVoices?.() ?? [];
      if (voices.length > 0 || !isAndroidWebView()) {
        synth.cancel();
        const utterance = new SpeechSynthesisUtterance(cleaned);
        utterance.lang = 'ja-JP';
        utterance.rate = rate;
        const jaVoice = voices.find((v) => /^ja([-_]|$)/i.test(v.lang));
        if (jaVoice) utterance.voice = jaVoice;
        synth.speak(utterance);
        return true;
      }
    } catch {
      // fall through to <audio>
    }
  }

  // 3. HTML5 <audio> fallback.
  return speakWithAudio(cleaned, rate);
}

/** Stop any ongoing speech on every backend. */
export function stopSpeech(): void {
  if (typeof window === 'undefined') return;
  try {
    void nativePlugin()?.stopSpeech?.();
  } catch {
    // ignore
  }
  try {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  } catch {
    // ignore
  }
  fallbackAudio?.pause();
  fallbackAudio = undefined;
}
