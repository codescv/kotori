import { describe, expect, it } from 'vitest';
import { buildM3Tokens, DEFAULT_SEED_COLOR, normaliseSeed } from './m3-theme';

describe('m3-theme', () => {
  it('derives full dark & light schemes from the seed', () => {
    const dark = buildM3Tokens(DEFAULT_SEED_COLOR, true);
    const light = buildM3Tokens(DEFAULT_SEED_COLOR, false);
    expect(Object.keys(dark)).toContain('--md-sys-color-surface-container-high');
    expect(dark['--md-sys-color-primary']).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark['--md-sys-color-surface']).not.toBe(light['--md-sys-color-surface']);
    // Dark surfaces are dark, light surfaces are light.
    const lum = (hex: string): number => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(lum(dark['--md-sys-color-surface'])).toBeLessThan(lum(light['--md-sys-color-surface']));
  });

  it('changes with the seed and normalises input', () => {
    expect(buildM3Tokens('#ff0000', true)['--md-sys-color-primary']).not.toBe(buildM3Tokens('#0000ff', true)['--md-sys-color-primary']);
    expect(normaliseSeed('ABC')).toBe('#aabbcc');
    expect(normaliseSeed('not a colour')).toBe(DEFAULT_SEED_COLOR);
  });
});
