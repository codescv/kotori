/**
 * Native Japanese TTS bridge for the Android WebView.
 *
 * Android System WebView exposes `window.speechSynthesis` but never wires a
 * synthesizer behind it (Chromium only does that in the Chrome APK), so
 * `speak()` is silently a no-op and `getVoices()` is empty. On the native
 * Android platform we therefore replace `speechSynthesis` /
 * `SpeechSynthesisUtterance` with a minimal Web Speech shim backed by
 * `KotoriTorrentPlugin.speakText` / `stopSpeech` (system `TextToSpeech`, with
 * an online Japanese audio fallback). The shared UI keeps using the standard
 * Web Speech API unchanged.
 */

export interface NativeSpeechPlugin {
  speakText(options: { text: string; lang?: string; rate?: number }): Promise<{ ok: boolean; engine?: 'system' | 'online'; reason?: string }>;
  stopSpeech(): Promise<void>;
}

type UtteranceHandler = ((this: unknown, ev: { readonly type: string; readonly error?: string }) => void) | null;

/** Plain-object stand-in for `SpeechSynthesisUtterance` (no native type checks on `voice`). */
export class NativeSpeechUtterance {
  text: string;
  lang = '';
  rate = 1;
  pitch = 1;
  volume = 1;
  voice: unknown = null;
  onstart: UtteranceHandler = null;
  onend: UtteranceHandler = null;
  onerror: UtteranceHandler = null;
  onpause: UtteranceHandler = null;
  onresume: UtteranceHandler = null;
  onboundary: UtteranceHandler = null;
  onmark: UtteranceHandler = null;
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(text = '') {
    this.text = text;
  }

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** @internal */
  fire(type: 'start' | 'end' | 'error', error?: string): void {
    const ev = error === undefined ? { type, utterance: this } : { type, utterance: this, error };
    const handler = this[`on${type}` as const];
    try {
      handler?.call(this, ev);
    } catch (e) {
      console.warn('[kotori:tts] utterance handler failed', e);
    }
    for (const l of this.listeners.get(type) ?? []) {
      try {
        l(ev);
      } catch (e) {
        console.warn('[kotori:tts] utterance listener failed', e);
      }
    }
  }
}

/** A single synthetic Japanese voice so callers that look for `ja-*` voices find one. */
const NATIVE_VOICE = Object.freeze({ default: true, lang: 'ja-JP', localService: true, name: 'Kotori Japanese (Android)', voiceURI: 'kotori-android-ja' });

export interface NativeSpeechSynthesis {
  readonly pending: boolean;
  readonly speaking: boolean;
  readonly paused: boolean;
  onvoiceschanged: (() => void) | null;
  speak(utterance: NativeSpeechUtterance): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  getVoices(): readonly (typeof NATIVE_VOICE)[];
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Web Speech `speechSynthesis` shim over the native plugin. */
export function createNativeSpeechSynthesis(plugin: NativeSpeechPlugin): NativeSpeechSynthesis {
  let speaking = false;
  let generation = 0;
  return {
    get pending() {
      return false;
    },
    get speaking() {
      return speaking;
    },
    get paused() {
      return false;
    },
    onvoiceschanged: null,
    speak(utterance) {
      const text = String(utterance?.text ?? '').trim();
      if (text === '') return;
      const mine = ++generation;
      speaking = true;
      const rate = Number.isFinite(utterance.rate) && utterance.rate > 0 ? utterance.rate : 1;
      plugin
        .speakText({ text, lang: utterance.lang || 'ja-JP', rate })
        .then((res) => {
          if (mine === generation) speaking = res.ok;
          if (res.ok) {
            utterance.fire('start');
            // Native playback end is not observable here; report `end` right away so callers never wait forever.
            utterance.fire('end');
          } else if (res.reason !== 'superseded') {
            utterance.fire('error', res.reason ?? 'synthesis-failed');
          }
        })
        .catch((error: unknown) => {
          if (mine === generation) speaking = false;
          console.warn('[kotori:tts] native speakText failed', error);
          utterance.fire('error', 'synthesis-unavailable');
        });
    },
    cancel() {
      generation++;
      speaking = false;
      void plugin.stopSpeech().catch(() => undefined);
    },
    pause() {
      // not supported natively
    },
    resume() {
      // not supported natively
    },
    getVoices: () => [NATIVE_VOICE],
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
}

/**
 * Replace `target.speechSynthesis` / `target.SpeechSynthesisUtterance` with the
 * native-backed shim. Returns `false` when nothing was installed.
 */
export function installNativeSpeechSynthesis(plugin: NativeSpeechPlugin, target: object = globalThis): boolean {
  try {
    const synth = createNativeSpeechSynthesis(plugin);
    Object.defineProperty(target, 'speechSynthesis', { value: synth, configurable: true, enumerable: true, writable: false });
    Object.defineProperty(target, 'SpeechSynthesisUtterance', { value: NativeSpeechUtterance, configurable: true, enumerable: false, writable: true });
    return true;
  } catch (error) {
    console.warn('[kotori:tts] could not install native speech synthesis', error);
    return false;
  }
}
