import { describe, expect, it } from 'vitest';
import { parseVolumeName } from './volume-name';

describe('parseVolumeName', () => {
  it.each([
    ['よつばと! 第01巻.mokuro', 'よつばと!', 1],
    ['ワンピース 第３巻', 'ワンピース', 3],
    ['薬屋のひとりごと 第十二巻.cbz', '薬屋のひとりごと', 12],
    ['葬送のフリーレン 5巻', '葬送のフリーレン', 5],
    ['Yotsuba v03.cbz', 'Yotsuba', 3],
    ['Yotsuba_v10.5.zip', 'Yotsuba', 10.5],
    ['Dungeon Meshi Vol. 3', 'Dungeon Meshi', 3],
    ['Dungeon Meshi - Volume 07 (Digital)', 'Dungeon Meshi (Digital)', 7],
    ['Chainsaw Man 03', 'Chainsaw Man', 3],
    ['/library/manga/Frieren/Frieren 02/', 'Frieren', 2],
    ['C:\\manga\\Vol3.mokuro', 'Vol3', 3],
    ['(一般コミック) [あずまきよひこ] よつばと! 第01巻 [DL版].cbz', 'よつばと!', 1],
    ['[山田鐘人×アベツカサ] 葬送のフリーレン 第03巻 [Digital].mokuro', '葬送のフリーレン', 3],
  ])('%s', (name, seriesTitle, volumeNumber) => {
    expect(parseVolumeName(name)).toEqual({ seriesTitle, volumeNumber });
  });

  it('omits volumeNumber when none is present', () => {
    const r = parseVolumeName('Love Live! Sunshine.cbz');
    expect(r).toEqual({ seriesTitle: 'Love Live! Sunshine' });
    expect('volumeNumber' in r).toBe(false);
  });

  it('keeps the name as title for a bare number', () => {
    expect(parseVolumeName('03')).toEqual({ seriesTitle: '03', volumeNumber: 3 });
  });
});
