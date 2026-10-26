import { describe, expect, it } from 'vitest';
import type { MangaBlock } from '../types';
import { generateStructured } from './structured';
import { RawBubbleOcrSchema } from './explain-schema';
import { boxToRectFraction, ocrBubble, pageGuide } from './vision';
import { fakeClient } from './test-helpers';

const image = { mimeType: 'image/jpeg', base64: 'AA', width: 100, height: 100 };
const block = (index: number): MangaBlock => ({ index, rect: { left: 0, top: 0, right: 1, bottom: 1 }, vertical: true, fontSize: 1, zIndex: index, lines: ['x'], text: 'x', source: 'mokuro' });

describe('boxToRectFraction', () => {
  it('scales 0..1000 boxes, keeps fractions, clamps and swaps', () => {
    expect(boxToRectFraction({ left: 100, top: 200, right: 500, bottom: 1200 })).toEqual({ left: 0.1, top: 0.2, right: 0.5, bottom: 1 });
    expect(boxToRectFraction({ left: 0.5, top: 0.1, right: 0.2, bottom: 0.3 })).toEqual({ left: 0.2, top: 0.1, right: 0.5, bottom: 0.3 });
    expect(boxToRectFraction({ left: -50, top: Number.NaN, right: 10, bottom: 20 })).toEqual({ left: 0, top: 0, right: 0.01, bottom: 0.02 });
  });
});

describe('ocrBubble', () => {
  it('joins trimmed lines and skips explain when not requested', async () => {
    const client = fakeClient([() => ({ text: '```json\n{"lines":[" あ ","","い"],"vertical":false}\n```', usage: { promptTokens: 1, outputTokens: 1 } })]);
    let explained = false;
    const res = await ocrBubble(
      client,
      { volumeId: 'v', pageIndex: 1, rect: { left: 0, top: 0, right: 5, bottom: 5 }, image, explain: false, targetLanguage: 'en' },
      {
        model: 'm',
        now: () => 7,
        explain: async () => {
          explained = true;
          throw new Error('should not run');
        },
      },
    );
    expect(res).toEqual({ volumeId: 'v', pageIndex: 1, rect: { left: 0, top: 0, right: 5, bottom: 5 }, lines: ['あ', 'い'], text: 'あい', vertical: false, model: 'm', createdAt: 7, usage: { promptTokens: 1, outputTokens: 1 } });
    expect(explained).toBe(false);
    expect(client.calls[0]?.responseMimeType).toBe('application/json');
  });
});

describe('pageGuide', () => {
  it('orders bubbles, normalises boxes and validates block indexes', async () => {
    const client = fakeClient([
      () => ({
        text: JSON.stringify({
          summary: 'A fight',
          bubbles: [
            { order: 2, box: { left: 0, top: 500, right: 400, bottom: 900 }, text: 'B', translation: 'b', blockIndex: 9 },
            { order: 1, box: { left: 600, top: 0, right: 1000, bottom: 300 }, text: 'A', translation: 'a', blockIndex: 1, speaker: 'Gin', note: 'n' },
            { box: { left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 }, text: 'C', translation: 'c' },
          ],
        }),
      }),
    ]);
    const res = await pageGuide(client, { volumeId: 'v', pageIndex: 3, image, targetLanguage: 'en', knownBlocks: [block(0), block(1)] }, { model: 'm', now: () => 1 });
    expect(res.summary).toBe('A fight');
    expect(res.bubbles.map((b) => [b.order, b.text, b.blockIndex])).toEqual([
      [1, 'A', 1],
      [2, 'B', undefined],
      [3, 'C', undefined],
    ]);
    expect(res.bubbles[0]).toMatchObject({ rectFraction: { left: 0.6, top: 0, right: 1, bottom: 0.3 }, speaker: 'Gin', note: 'n' });
    expect(res.bubbles[2]?.rectFraction).toEqual({ left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 });
  });
});

describe('generateStructured', () => {
  it('returns value + usage on first success', async () => {
    const client = fakeClient([() => ({ text: '{"lines":["a"],"vertical":true}', model: 'mv' })]);
    const r = await generateStructured(client, { model: 'm', contents: [] }, RawBubbleOcrSchema);
    expect(r).toEqual({ value: { lines: ['a'], vertical: true }, model: 'mv' });
  });
  it('does not retry non-validation errors', async () => {
    const client = fakeClient([
      () => {
        throw new Error('boom');
      },
    ]);
    await expect(generateStructured(client, { model: 'm', contents: [] }, RawBubbleOcrSchema)).rejects.toThrow('boom');
    expect(client.calls).toHaveLength(1);
  });
});
