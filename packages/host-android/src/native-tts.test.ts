import { describe, expect, it, vi } from 'vitest';
import { createNativeSpeechSynthesis, installNativeSpeechSynthesis, NativeSpeechUtterance, type NativeSpeechPlugin } from './native-tts';

function fakePlugin(result: Awaited<ReturnType<NativeSpeechPlugin['speakText']>> | Error = { ok: true, engine: 'system' }) {
  const plugin = {
    speakText: vi.fn(async (_options: { text: string; lang?: string; rate?: number }) => {
      if (result instanceof Error) throw result;
      return result;
    }),
    stopSpeech: vi.fn(async () => undefined),
  };
  return plugin;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('native speech synthesis shim', () => {
  it('replaces speechSynthesis / SpeechSynthesisUtterance and forwards speak() like the UI helper calls it', async () => {
    const plugin = fakePlugin({ ok: true, engine: 'online' });
    const win: Record<string, unknown> = { speechSynthesis: { speak: () => undefined, getVoices: () => [] } };
    expect(installNativeSpeechSynthesis(plugin, win)).toBe(true);
    const synth = win['speechSynthesis'] as ReturnType<typeof createNativeSpeechSynthesis>;
    const Utterance = win['SpeechSynthesisUtterance'] as typeof NativeSpeechUtterance;
    // Mirrors packages/ui/src/lib/tts.ts: cancel → new utterance → ja voice → speak.
    synth.cancel();
    const u = new Utterance('  今日は学校に行きたくない。 ');
    u.lang = 'ja-JP';
    u.rate = 0.95;
    const voice = synth.getVoices().find((v) => /^ja([-_]|$)/i.test(v.lang));
    expect(voice).toBeDefined();
    u.voice = voice;
    const events: string[] = [];
    u.onstart = () => events.push('start');
    u.addEventListener('end', () => events.push('end'));
    synth.speak(u);
    expect(synth.speaking).toBe(true);
    await flush();
    expect(plugin.stopSpeech).toHaveBeenCalledTimes(1);
    expect(plugin.speakText).toHaveBeenCalledWith({ text: '今日は学校に行きたくない。', lang: 'ja-JP', rate: 0.95 });
    expect(events).toEqual(['start', 'end']);
  });

  it('reports errors through onerror and ignores empty text', async () => {
    const plugin = fakePlugin(new Error('no engine'));
    const synth = createNativeSpeechSynthesis(plugin);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const u = new NativeSpeechUtterance('猫');
    const errors: string[] = [];
    u.onerror = (ev) => errors.push(ev.error ?? '');
    synth.speak(u);
    synth.speak(new NativeSpeechUtterance('   '));
    await flush();
    expect(plugin.speakText).toHaveBeenCalledTimes(1);
    expect(plugin.speakText.mock.calls[0]?.[0]).toMatchObject({ lang: 'ja-JP', rate: 1 });
    expect(errors).toEqual(['synthesis-unavailable']);
    expect(synth.speaking).toBe(false);
    warn.mockRestore();
  });

  it('a superseded request is neither an error nor a start', async () => {
    const synth = createNativeSpeechSynthesis(fakePlugin({ ok: false, reason: 'superseded' }));
    const u = new NativeSpeechUtterance('犬');
    const seen: string[] = [];
    u.onstart = () => seen.push('start');
    u.onerror = () => seen.push('error');
    synth.speak(u);
    await flush();
    expect(seen).toEqual([]);
  });
});
