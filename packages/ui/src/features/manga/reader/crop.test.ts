import { describe, expect, it } from 'vitest';
import type { MangaBubbleOcrResult } from '@kotori/core';
import { blockFromOcr } from './BubbleSelectTool';
import { isUsableSelection, planCrop, planDownscale, stripDataUrl } from './crop';

describe('planCrop', () => {
  it('maps page pixels onto the natural image and caps the long edge at 1024', () => {
    // Natural image is twice the OCR page size.
    const plan = planCrop({ left: 100, top: 200, right: 700, bottom: 1400 }, { width: 1200, height: 1700 }, { width: 2400, height: 3400 });
    expect(plan).toMatchObject({ sx: 200, sy: 400, sw: 1200, sh: 2400 });
    expect(Math.max(plan.width, plan.height)).toBe(1024);
    expect(plan.width).toBe(512);
  });

  it('does not upscale small crops and clamps to the page', () => {
    const plan = planCrop({ left: -50, top: 10, right: 150, bottom: 110 }, { width: 1200, height: 1700 }, { width: 1200, height: 1700 });
    expect(plan).toEqual({ sx: 0, sy: 10, sw: 150, sh: 100, width: 150, height: 100 });
  });

  it('accepts inverted rects', () => {
    const plan = planCrop({ left: 300, top: 300, right: 100, bottom: 100 }, { width: 1000, height: 1000 }, { width: 500, height: 500 });
    expect(plan).toMatchObject({ sx: 50, sy: 50, sw: 100, sh: 100 });
  });
});

describe('planDownscale', () => {
  it('downscales a page to ≤ 1536 px', () => {
    expect(planDownscale({ width: 2400, height: 3400 })).toMatchObject({ sw: 2400, sh: 3400, height: 1536, width: 1084 });
    expect(planDownscale({ width: 800, height: 1000 })).toMatchObject({ width: 800, height: 1000 });
  });
});

describe('helpers', () => {
  it('stripDataUrl / isUsableSelection', () => {
    expect(stripDataUrl('data:image/jpeg;base64,QUJD')).toBe('QUJD');
    expect(isUsableSelection({ left: 0, top: 0, right: 5, bottom: 100 })).toBe(false);
    expect(isUsableSelection({ left: 0, top: 0, right: 40, bottom: 100 })).toBe(true);
  });

  it('blockFromOcr builds a vlm block with text = lines.join', () => {
    const res: MangaBubbleOcrResult = {
      volumeId: 'v',
      pageIndex: 1,
      rect: { left: 0, top: 0, right: 80, bottom: 200 },
      lines: ['行かな', 'きゃ'],
      text: '行かなきゃ',
      vertical: true,
      confidence: 0.9,
      model: 'm',
      createdAt: 0,
    };
    const b = blockFromOcr(res, 3);
    expect(b).toMatchObject({ source: 'vlm', zIndex: 3, vertical: true, text: '行かなきゃ', lines: ['行かな', 'きゃ'], confidence: 0.9 });
    expect(b.fontSize).toBe(40);
  });
});
