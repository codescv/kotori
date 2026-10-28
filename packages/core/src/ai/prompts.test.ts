import { describe, expect, it } from 'vitest';
import type { ExplainRequest, SentenceExplanation } from '../types';
import { buildBubbleOcrPrompt, buildExplainPrompt, buildFollowUpPrompt, buildPageGuidePrompt, PROMPT_VERSION, summariseExplanation, targetLanguageName } from './prompts';

const req: ExplainRequest = {
  sentence: '食べてんじゃねぇよ',
  source: { kind: 'manual' },
  targetLanguage: 'zh-CN',
  contextBefore: ['おい！'],
  contextAfter: ['うるせぇ'],
  sceneHint: 'Gintama',
  focusCharIndex: 3,
};

const textOf = (parts: readonly unknown[]): string => parts.map((p) => (p as { text?: string }).text ?? '').join('\n');

describe('buildExplainPrompt', () => {
  it('quotes the target verbatim and separates context', () => {
    const p = buildExplainPrompt(req);
    expect(PROMPT_VERSION).toBe('v3');
    expect(p.systemInstruction).toContain('verbatim substring');
    expect(p.systemInstruction).toContain('textbookForm');
    expect(p.systemInstruction).toContain('Simplified Chinese');
    const t = textOf(p.contents[0]?.parts ?? []);
    expect(t).toContain('<<<\n食べてんじゃねぇよ\n>>>');
    expect(t).toContain('Context before (do not explain):\n- おい！');
    expect(t).toContain('- うるせぇ');
    expect(t).toContain('Scene: Gintama');
    expect(t).toContain('「ん」');
  });
  it('P0 rule 3 asks for canonical kanji lemmas and no longer mentions lemmaRuby / jlpt', () => {
    const sys = buildExplainPrompt(req).systemInstruction;
    expect(sys).toContain('canonical dictionary headword');
    expect(sys).toContain('"賭ける" for "命をかけて"');
    expect(sys).toContain('"分かる" for "わかんない"');
    expect(sys).toContain('"やっぱり"');
    expect(sys).not.toContain('lemmaRuby');
    expect(sys).not.toContain('jlpt');
  });
  it('omits optional sections', () => {
    const t = textOf(buildExplainPrompt({ sentence: 'あ', source: { kind: 'manual' }, targetLanguage: 'en' }).contents[0]?.parts ?? []);
    expect(t).not.toContain('Context');
    expect(t).not.toContain('clicked');
    expect(targetLanguageName('en')).toBe('English');
  });
});

describe('buildFollowUpPrompt', () => {
  const expl = {
    id: 'ex_1',
    sentence: 'あ',
    ruby: [],
    translation: 'ah',
    chunks: [],
    vocab: [],
    grammar: [],
    targetLanguage: 'en',
    model: 'm',
    promptVersion: 'v1',
    createdAt: 0,
    fromCache: false,
  } satisfies SentenceExplanation;
  it('includes the explanation summary, history and question', () => {
    const p = buildFollowUpPrompt(
      expl,
      [
        { id: '1', role: 'user', text: 'q1', createdAt: 0 },
        { id: '2', role: 'model', text: 'a1', createdAt: 0 },
        { id: '3', role: 'model', text: ' ', createdAt: 0 },
      ],
      'q2',
      'zh-TW',
    );
    expect(p.systemInstruction).toContain(summariseExplanation(expl));
    expect(p.systemInstruction).toContain('Traditional Chinese');
    expect(p.contents.map((c) => [c.role, textOf(c.parts)])).toEqual([
      ['user', 'q1'],
      ['model', 'a1'],
      ['user', 'q2'],
    ]);
  });
  it('injects assistant persona nickname and soul into follow-up systemInstruction', () => {
    const p = buildFollowUpPrompt(expl, [], '为什么用ねぇ？', 'zh-CN', {
      name: '小鳥ちゃん',
      soul: '你是一只傲娇但热心的京都小鸟，说话结尾偶尔加上「〜ちゅん」。',
    });
    expect(p.systemInstruction).toContain('Your name/nickname is "小鳥ちゃん".');
    expect(p.systemInstruction).toContain('你是一只傲娇但热心的京都小鸟');
  });
});

describe('vision prompts', () => {
  const image = { mimeType: 'image/jpeg', base64: 'AAAA', width: 100, height: 200 };
  it('bubble OCR attaches the image', () => {
    const p = buildBubbleOcrPrompt({ volumeId: 'v', pageIndex: 0, rect: { left: 0, top: 0, right: 1, bottom: 1 }, image, explain: false, targetLanguage: 'en' });
    expect(p.contents[0]?.parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } });
    expect(p.systemInstruction).toContain('right to left');
  });
  it('page guide lists known blocks', () => {
    const p = buildPageGuidePrompt({
      volumeId: 'v',
      pageIndex: 0,
      image,
      targetLanguage: 'en',
      knownBlocks: [{ index: 4, rect: { left: 0, top: 0, right: 1, bottom: 1 }, vertical: true, fontSize: 10, zIndex: 0, lines: ['あ'], text: 'あ', source: 'mokuro' }],
    });
    expect(textOf(p.contents[0]?.parts ?? [])).toContain('#4: あ');
    expect(p.systemInstruction).toContain('0..1000');
  });
});
