import { describe, expect, it } from 'vitest';
import { JsonArrayRowSplitter, streamJsonArrayRows } from './json-row-stream';

const enc = new TextEncoder();

const TERM_BANK = JSON.stringify([
  ['見る', '', 'non-lemma', '', 0, [['みる', ['alternative kanji']]], 0, ''],
  [
    '賭ける',
    'かける',
    'v ichidan vt',
    'v1',
    10,
    [
      {
        type: 'structured-content',
        content: [
          {
            tag: 'ol',
            data: { content: 'glosses' },
            content: [
              {
                tag: 'li',
                content: [
                  '赌博，打赌',
                  { tag: 'div', data: { content: 'example-sentence-a' }, content: '命を賭けて戦う' },
                  { tag: 'div', data: { content: 'example-sentence-b' }, content: '赌上性命战斗' },
                ],
              },
            ],
          },
        ],
      },
    ],
    1234,
    '',
  ],
  ['括弧', 'かっこ', 'n', '', 0, ['bracket "[]{}" with \\"escaped\\" quotes and \\\\ backslash \\\\\\" tricky'], 0, ''],
  ['ワカル', 'わかる', 'v godan', 'v5', 0, ['懂；明白 — 繁體：飛翔、維持生計'], 0, ''],
]);

const META_BANK = JSON.stringify([
  ['賭ける', 'freq', { reading: 'かける', frequency: { value: 3851, displayValue: '3851' } }],
  ['かける', 'freq', { value: 202, displayValue: '202㋕' }],
  ['掛ける', 'freq', { reading: 'かける', frequency: { value: 2055, displayValue: '2055' } }],
  ['雨', 'pitch', { reading: 'あめ', pitches: [{ position: 1 }] }],
  ['飴', 'pitch', { reading: 'あめ', pitches: [{ position: 0, nasal: [2], devoice: [] }] }],
  ['猫', 'freq', 812],
]);

/** Feed `bytes` to a splitter in fixed `step`-sized chunks. */
function splitWithStep(bytes: Uint8Array, step: number): unknown[] {
  const rows: unknown[] = [];
  const s = new JsonArrayRowSplitter((row) => rows.push(row));
  for (let i = 0; i < bytes.length; i += step) s.push(bytes.subarray(i, Math.min(bytes.length, i + step)));
  s.end();
  expect(s.done).toBe(true);
  return rows;
}

/** Feed `bytes` split into exactly two chunks at `cut`. */
function splitAt(bytes: Uint8Array, cut: number): unknown[] {
  const rows: unknown[] = [];
  const s = new JsonArrayRowSplitter((row) => rows.push(row));
  s.push(bytes.subarray(0, cut));
  s.push(bytes.subarray(cut));
  s.end();
  return rows;
}

describe('JsonArrayRowSplitter', () => {
  it('R3-1: term_bank / term_meta_bank rows survive a chunk boundary at EVERY byte offset', () => {
    for (const text of [TERM_BANK, META_BANK]) {
      const bytes = enc.encode(text);
      const expected = JSON.parse(text) as unknown[];
      for (let cut = 0; cut <= bytes.length; cut++) {
        expect(splitAt(bytes, cut)).toEqual(expected);
      }
      for (const step of [1, 2, 3, 5, 7, 17, 64, 4096]) {
        expect(splitWithStep(bytes, step)).toEqual(expected);
      }
    }
  });

  it('R3-2: brackets, braces, escaped quotes and backslashes inside strings never end a row', () => {
    const tricky = [
      ['a]', '}', '[[{{', 'x\\"]', 0],
      ['\\', '"', '\\\\"', ']]]]', { k: '}{][' }],
      ['end'],
    ];
    const text = JSON.stringify(tricky);
    expect(text).toContain('\\"');
    expect(text).toContain('\\\\');
    const bytes = enc.encode(text);
    for (let step = 1; step <= bytes.length; step++) expect(splitWithStep(bytes, step)).toEqual(tricky);
  });

  it('R3-3: multi-byte UTF-8 kanji / kana split across chunks decode without mojibake', () => {
    const rows = [['取り戻す', 'とりもどす', '夺回；𠮷野家 🍣'], ['ｶﾀｶﾅ', 'ヴァイオリン', '飛翔']];
    const bytes = enc.encode(JSON.stringify(rows));
    // Every cut position, including those inside 3- and 4-byte sequences.
    let insideMultibyte = 0;
    for (let cut = 1; cut < bytes.length; cut++) {
      if ((bytes[cut]! & 0xc0) === 0x80) insideMultibyte++;
      expect(splitAt(bytes, cut)).toEqual(rows);
    }
    expect(insideMultibyte).toBeGreaterThan(20);
    expect(splitWithStep(bytes, 1)).toEqual(rows);
  });

  it('R3-4: JPDB frequency rows with and without reading', () => {
    const text = '[["賭ける","freq",{"reading":"かける","frequency":{"value":3851,"displayValue":"3851"}}],["かける","freq",{"value":202,"displayValue":"202㋕"}]]';
    const bytes = enc.encode(text);
    for (const step of [1, 3, 17]) {
      expect(splitWithStep(bytes, step)).toEqual([
        ['賭ける', 'freq', { reading: 'かける', frequency: { value: 3851, displayValue: '3851' } }],
        ['かける', 'freq', { value: 202, displayValue: '202㋕' }],
      ]);
    }
  });

  it('handles whitespace, BOM, pretty-printing and top-level scalars', () => {
    const text = '\uFEFF [\n  [1, 2],\n  "str]ing",\n  42 ,\n  true,\n  {"a": [1]}\n]\n';
    const bytes = enc.encode(text);
    for (const step of [1, 2, 9, 1000]) expect(splitWithStep(bytes, step)).toEqual([[1, 2], 'str]ing', 42, true, { a: [1] }]);
    expect(splitWithStep(enc.encode('[]'), 1)).toEqual([]);
    expect(splitWithStep(enc.encode('[1,2]'), 1)).toEqual([1, 2]);
  });

  it('does not alias a reused upstream buffer across chunks', () => {
    const bytes = enc.encode(META_BANK);
    const rows: unknown[] = [];
    const s = new JsonArrayRowSplitter((row) => rows.push(row));
    const buf = new Uint8Array(5);
    for (let i = 0; i < bytes.length; i += 5) {
      const n = Math.min(5, bytes.length - i);
      buf.set(bytes.subarray(i, i + n));
      s.push(buf.subarray(0, n));
      buf.fill(0x20); // simulate the producer overwriting its buffer
    }
    s.end();
    expect(rows).toEqual(JSON.parse(META_BANK));
  });

  it('reports truncated input and malformed rows', () => {
    const s = new JsonArrayRowSplitter(() => undefined);
    s.push(enc.encode('[["a", "b"'));
    expect(() => s.end()).toThrow(/truncated/);
    const bad = new JsonArrayRowSplitter(() => undefined);
    expect(() => bad.push(enc.encode('[[1,,2]]'))).toThrow(/row 0/);
  });

  it('streamJsonArrayRows works over async chunk sources and awaits the row handler', async () => {
    const bytes = enc.encode(TERM_BANK);
    async function* gen(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < bytes.length; i += 11) yield bytes.subarray(i, i + 11);
    }
    const seen: unknown[] = [];
    const n = await streamJsonArrayRows(gen(), async (row) => {
      await Promise.resolve();
      seen.push(row);
    });
    expect(n).toBe(4);
    expect(seen).toEqual(JSON.parse(TERM_BANK));
  });
});
