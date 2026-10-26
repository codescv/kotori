import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/sqlite';
import { SettingsStore } from './store';

function store(): SettingsStore {
  return new SettingsStore(openDatabase(':memory:'), '/data');
}

describe('settings validation hardening', () => {
  it.each([
    [{ ai: { temperature: Number.NaN } }, 'ai.temperature'],
    [{ ai: { temperature: '1' } }, 'ai.temperature'],
    [{ ui: { theme: 'neon' } }, 'ui.theme'],
    [{ library: { animeRoots: 'x' } }, 'library.animeRoots'],
    [{ manga: { fit: 'stretch' } }, 'manga.fit'],
    [{ ai: { provider: { provider: 'vertex-ai', location: 'us-central1', auth: { kind: 'magic' } } } }, 'ai.provider.auth.kind'],
  ])('rejects %j (%s) with invalid-argument', (patch, field) => {
    const s = store();
    expect(() => s.update(patch as never)).toThrow(expect.objectContaining({ code: 'invalid-argument', details: { field } }));
    expect(s.get().ai.temperature).toBe(0.2);
  });

  it.each([{ ai: null }, { ui: null }, { ai: 5 }])('rejects non-object sections %j as invalid-argument', (patch) => {
    expect(() => store().update(patch as never)).toThrow(expect.objectContaining({ code: 'invalid-argument' }));
  });

  it('rejects a null provider (required) but lets null clear optional fields', () => {
    const s = store();
    expect(() => s.update({ ai: { provider: null } } as never)).toThrow(expect.objectContaining({ code: 'invalid-argument' }));
    s.update({ ai: { thinkingBudget: 0, provider: { provider: 'gemini-api', apiKey: 'k', baseUrl: 'https://proxy' } } });
    expect(s.get().ai.thinkingBudget).toBe(0);
    const cleared = s.update({ ai: { thinkingBudget: null, provider: { baseUrl: null } } } as never);
    expect(cleared.ai.thinkingBudget).toBeUndefined();
    expect(cleared.ai.provider).toEqual({ provider: 'gemini-api', apiKey: 'k' });
  });

  it('does not alias the caller patch object after a provider switch', () => {
    const s = store();
    const provider = { provider: 'vertex-ai' as const, location: 'global', auth: { kind: 'adc' as const } };
    s.update({ ai: { provider } });
    (provider as { location: string }).location = 'mutated';
    expect(s.get().ai.provider).toMatchObject({ location: 'global' });
  });
});
