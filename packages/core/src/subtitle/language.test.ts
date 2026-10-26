import { describe, expect, it } from 'vitest';
import { detectSubtitleLanguageFromName } from './language';

describe('detectSubtitleLanguageFromName', () => {
  it('reads dot-suffix codes before the extension', () => {
    expect(detectSubtitleLanguageFromName('[SubsPlease] Frieren - 01 (1080p).ja.ass')).toBe('ja');
    expect(detectSubtitleLanguageFromName('Frieren.S01E01.jpn.srt')).toBe('ja');
    expect(detectSubtitleLanguageFromName('Frieren - 01.en.srt')).toBe('en');
    expect(detectSubtitleLanguageFromName('Frieren - 01.eng.vtt')).toBe('en');
    expect(detectSubtitleLanguageFromName('Frieren - 01.zh-Hans.ass')).toBe('zh-CN');
    expect(detectSubtitleLanguageFromName('Frieren - 01.zh-Hant.ass')).toBe('zh-TW');
    expect(detectSubtitleLanguageFromName('Frieren - 01.chs.ass')).toBe('zh-CN');
    expect(detectSubtitleLanguageFromName('Frieren - 01.cht.ass')).toBe('zh-TW');
  });

  it('skips modifiers and trailing [cc] markers', () => {
    expect(detectSubtitleLanguageFromName('Title.S01E05.WEBRip.Netflix.ja[cc].srt')).toBe('ja');
    expect(detectSubtitleLanguageFromName('Title - 01.ja.forced.ass')).toBe('ja');
    expect(detectSubtitleLanguageFromName('/subs/Title - 01.en.sdh.srt')).toBe('en');
  });

  it('reads bracketed codes', () => {
    expect(detectSubtitleLanguageFromName('[JP] Title - 01.srt')).toBe('ja');
    expect(detectSubtitleLanguageFromName('Title - 01 [JPN].ass')).toBe('ja');
    expect(detectSubtitleLanguageFromName('Title - 01 (ENG).srt')).toBe('en');
    expect(detectSubtitleLanguageFromName('[Group] Title [01][CHS].ass')).toBe('zh-CN');
    expect(detectSubtitleLanguageFromName('Title_01_jpn.srt')).toBe('ja');
  });

  it('reads CJK words', () => {
    expect(detectSubtitleLanguageFromName('タイトル 第01話 日本語.srt')).toBe('ja');
    expect(detectSubtitleLanguageFromName('[字幕组] 标题 [01][简体].ass')).toBe('zh-CN');
    expect(detectSubtitleLanguageFromName('[字幕組] 標題 [01][繁體].ass')).toBe('zh-TW');
  });

  it('returns undefined when there is no hint', () => {
    expect(detectSubtitleLanguageFromName('[SubsPlease] Frieren - 01 (1080p).ass')).toBeUndefined();
    expect(detectSubtitleLanguageFromName('Italian Job.srt')).toBeUndefined();
    expect(detectSubtitleLanguageFromName('')).toBeUndefined();
  });
});
