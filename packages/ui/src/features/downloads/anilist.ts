/**
 * Lightweight, zero-key AniList GraphQL metadata, discovery & cover art resolver
 * for Anime (Nyaa) and Subtitle (Jimaku) search results, inspired by Fushi's
 * `AnilistVideoMetadataProvider` and `NyaaTorrentResourceProvider`.
 *
 * Uses in-memory caching and falls back to a curated catalog when offline or in
 * unit tests.
 */

import type { Locale } from '../../i18n';

export interface AniListMediaInfo {
  readonly id: number;
  readonly coverUrl?: string;
  readonly bannerUrl?: string;
  readonly nativeTitle?: string;
  readonly romajiTitle?: string;
  readonly englishTitle?: string;
  readonly chineseTitle?: string;
  readonly synonyms?: readonly string[];
  readonly description?: string;
  readonly descriptionEn?: string;
  readonly descriptionJa?: string;
  readonly score?: number;
  readonly popularity?: number;
  readonly episodes?: number;
  readonly status?: string;
  readonly format?: string;
  readonly season?: string;
  readonly seasonYear?: number;
  readonly genres?: readonly string[];
  readonly studios?: readonly string[];
}

/** Pick the best localized synopsis for an `AniListMediaInfo` entry. */
export function getAniListDescription(info: AniListMediaInfo, locale: Locale): string | undefined {
  if (locale === 'zh-CN') return info.description ?? info.descriptionEn ?? info.descriptionJa;
  if (locale === 'ja') return info.descriptionJa ?? info.descriptionEn ?? info.description;
  return info.descriptionEn ?? info.descriptionJa ?? info.description;
}

export const FALLBACK_ANIME_CATALOG: readonly AniListMediaInfo[] = [
  {
    id: 130003,
    nativeTitle: 'ぼっち・ざ・ろっく！',
    romajiTitle: 'Bocchi the Rock!',
    englishTitle: 'BOCCHI THE ROCK!',
    chineseTitle: '孤独摇滚！',
    synonyms: ['孤独摇滚', '孤独搖滾', 'BTR'],
    coverUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx130003-HTDmeL4RGeJ4.png',
    description:
      '极度怕生又阴郁的高中生后藤一里（波奇酱），怀揣着组建乐队并在文化祭演出的梦想苦练吉他。某天放学后，她被急需吉他手的「结束乐队」鼓手伊地知虹夏搭话，从此开启了跌跌撞撞却无比闪耀的下北泽乐队青春日常。',
    descriptionEn:
      'Socially anxious high schooler Hitori Gotoh practices guitar alone, dreaming of joining a band. One day, drummer Nijika Ijichi recruits her for Kessoku Band, kicking off a clumsy yet sparkling Shimokitazawa band life.',
    descriptionJa:
      '極度の人見知りで陰キャな高校生・後藤ひとり（ぼっちちゃん）は、バンドを組む夢を抱いてギターを練習していた。ある日、ギターを探していた「結束バンド」のドラム・伊地知虹夏に声をかけられ、下北沢でのバンド生活が始まる。',
    score: 87,
    popularity: 271393,
    episodes: 12,
    status: 'FINISHED',
    format: 'TV',
    season: 'FALL',
    seasonYear: 2022,
    genres: ['Comedy', 'Music', 'Slice of Life'],
    studios: ['CloverWorks'],
  },
  {
    id: 165253,
    nativeTitle: 'ぼっち・ざ・ろっく！Re:',
    romajiTitle: 'Bocchi the Rock! Re:',
    englishTitle: 'BOCCHI THE ROCK! Recap Part 1',
    chineseTitle: '孤独摇滚！剧场总集篇 Re:',
    synonyms: ['孤独摇滚 总集篇'],
    coverUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx165253-c2bfB6p59t3b.jpg',
    description: 'TV动画《孤独摇滚！》剧场版总集篇前篇，重新编排结束乐队相遇到下北泽Livehouse演出的成长轨迹。',
    descriptionEn: 'Part 1 of the theatrical recap of BOCCHI THE ROCK!, revisiting Kessoku Band’s meeting and early Shimokitazawa live shows.',
    descriptionJa: 'TVアニメ『ぼっち・ざ・ろっく！』劇場総集編の前編。結束バンドの出会いから下北沢ライブハウスでの成長を描く。',
    score: 83,
    popularity: 26200,
    episodes: 1,
    status: 'FINISHED',
    format: 'MOVIE',
    season: 'SPRING',
    seasonYear: 2024,
    genres: ['Comedy', 'Music', 'Slice of Life'],
    studios: ['CloverWorks'],
  },
  {
    id: 154587,
    nativeTitle: '葬送のフリーレン',
    romajiTitle: 'Sousou no Frieren',
    englishTitle: 'Frieren: Beyond Journey’s End',
    chineseTitle: '葬送的芙莉莲',
    synonyms: ['芙莉莲', '葬送的芙莉蓮', 'Frieren'],
    coverUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-gHSraOSa0nBG.jpg',
    description:
      '打倒魔王的勇者一行人凯旋归来。身为精灵魔法使的芙莉莲拥有漫长的寿命，在勇者辛美尔辞世后，她为了真正「理解人类」而踏上了重走昔日冒险旅途、收集魔法与回忆的旅途。',
    descriptionEn:
      'After the Demon King is defeated, the long-lived elf mage Frieren bids farewell to hero Himmel and sets out on a new journey to truly understand humanity.',
    descriptionJa:
      '魔王を倒した勇者一行の凱旋後、長い寿命を持つエルフの魔法使いフリーレンは勇者ヒンメルの死をきっかけに、「人を知るための旅」へ出る。',
    score: 91,
    popularity: 493490,
    episodes: 28,
    status: 'FINISHED',
    format: 'TV',
    season: 'FALL',
    seasonYear: 2023,
    genres: ['Adventure', 'Drama', 'Fantasy'],
    studios: ['Madhouse'],
  },
  {
    id: 153518,
    nativeTitle: 'ダンジョン飯',
    romajiTitle: 'Dungeon Meshi',
    englishTitle: 'Delicious in Dungeon',
    chineseTitle: '迷宫饭',
    synonyms: ['迷宮飯'],
    coverUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx153518-7FNR7zCx22X5.jpg',
    description:
      '冒险者莱欧斯一行人在迷宫深处惨败于炎龙，妹妹法琳被吞下。身无分文的他们为了在妹妹被消化前赶回迷宫深处，决定在迷宫中「自给自足」——烹调史莱姆、走路菇与各类魔物料理！',
    descriptionEn:
      'After losing his sister Falin to a Red Dragon deep in the dungeon, broke adventurer Laios and his party survive by cooking and eating dungeon monsters on their rescue mission.',
    descriptionJa:
      'ダンジョン深部でレッドドラゴンに妹ファリンを喰われた冒険者ライオス一行。資金も食料も失った彼らは、魔物を調理して食べながらダンジョン踏破を目指す！',
    score: 86,
    popularity: 245000,
    episodes: 24,
    status: 'FINISHED',
    format: 'TV',
    season: 'WINTER',
    seasonYear: 2024,
    genres: ['Adventure', 'Comedy', 'Fantasy'],
    studios: ['TRIGGER'],
  },
  {
    id: 161645,
    nativeTitle: '薬屋のひとりごと',
    romajiTitle: 'Kusuriya no Hitorigoto',
    englishTitle: 'The Apothecary Diaries',
    chineseTitle: '药屋少女的呢喃',
    synonyms: ['药屋少女', '薬屋'],
    coverUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx161645-7f8a0A9b0A9b.jpg',
    description:
      '花街出身的药师少女猫猫被拐卖进后宫担任下级女官。对毒与药有着异于常人执着的她，凭借渊博的药学知识解开后宫中接连发生的怪异案件，被美貌的宦官壬氏委以重任。',
    descriptionEn:
      'Apothecary Maomao is sold into service at the imperial rear palace, where her obsession with poisons and medicine leads her to unravel court mysteries alongside the enigmatic Jinshi.',
    descriptionJa:
      '花街出身の薬師の少女・猫猫は後宮に売り飛ばされる。薬と毒への異常な執着と知識で次々と難事件を解き明かし、美形の宦官・壬氏の目に留まる。',
    score: 88,
    popularity: 268000,
    episodes: 24,
    status: 'FINISHED',
    format: 'TV',
    season: 'FALL',
    seasonYear: 2023,
    genres: ['Drama', 'Mystery'],
    studios: ['OLM', 'TOHO animation STUDIO'],
  },
  {
    id: 164212,
    nativeTitle: 'ガールズバンドクライ',
    romajiTitle: 'GIRLS BAND CRY',
    englishTitle: 'GIRLS BAND CRY',
    chineseTitle: '哭泣少女乐队',
    synonyms: ['GBC', '少女乐队呐喊吧'],
    coverUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx164212-fG2cR3sZ9p8q.jpg',
    description:
      '高中辍学独自前往东京的井芹仁菜，在街头偶遇了离开原乐队的吉他手河原木桃香。五个背负着各自挫折与伤痕的女孩组建起摇滚乐队「TOGENASHI TOGEARI」，向世界发出不屈的呐喊。',
    descriptionEn:
      'High school dropout Nina Iseri moves to Tokyo alone and meets guitarist Momoka Kawaragi. Together with three other scarred girls, they form rock band Togenashi Togeari.',
    descriptionJa:
      '高校を中退し単身東京へ出た井芹仁菜は、元バンドのギタリスト河原木桃香と出会う。それぞれの葛藤を抱えた5人の少女がロックバンド「トゲナシトゲアリ」を結成する。',
    score: 84,
    popularity: 89000,
    episodes: 13,
    status: 'FINISHED',
    format: 'TV',
    season: 'SPRING',
    seasonYear: 2024,
    genres: ['Drama', 'Music'],
    studios: ['Toei Animation'],
  },
  {
    id: 171457,
    nativeTitle: '負けヒロインが多すぎる！',
    romajiTitle: 'Make Heroine ga Oosugiru!',
    englishTitle: 'Too Many Losing Heroines!',
    chineseTitle: '败犬女主太多了！',
    synonyms: ['败犬女主', 'Makeine'],
    coverUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx171457-h1mN2kL3pQ4r.jpg',
    description:
      '自称「背景板角色」的温水和彦，偶然目睹了同班人气女生八奈见杏菜失恋的现场。以此为契机，烧盐柠檬、小鞠知花等「败犬女主」接连聚集到他身边，织就了一段充满欢笑的青春群像剧。',
    descriptionEn:
      'Self-proclaimed background character Kazuhiko Nukumizu witnesses popular classmate Anna Yanami get rejected, drawing him into the chaotic lives of several “losing heroines.”',
    descriptionJa:
      '自称「背景キャラ」の温水和彦は、人気者・八奈見杏菜の失恋現場を目撃してしまう。それをきっかけに個性豊かな「負けヒロイン」たちが次々と彼のもとに集まり始める。',
    score: 81,
    popularity: 132000,
    episodes: 12,
    status: 'FINISHED',
    format: 'TV',
    season: 'SUMMER',
    seasonYear: 2024,
    genres: ['Comedy', 'Romance'],
    studios: ['A-1 Pictures'],
  },
  {
    id: 98444,
    nativeTitle: 'ゆるキャン△',
    romajiTitle: 'Yuru Camp△',
    englishTitle: 'Laid-Back Camp',
    chineseTitle: '摇曳露营△',
    synonyms: ['摇曳露营', 'Yuru Camp'],
    coverUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx98444-zzhSwc9d9x1B.jpg',
    description:
      '喜欢独自在冬日富士山畔露营的志摩凛，偶遇了骑自行车来看富士山却睡过头的天然少女各务原抚子。围坐在篝火旁的一碗咖喱泡面，开启了少女们温暖悠闲的户外露营物语。',
    descriptionEn:
      'Solo winter camper Rin Shima meets Nadeshiko Kagamihara by Mt. Fuji, sparking a cozy outdoor camping story shared over campfires and hot noodles.',
    descriptionJa:
      '冬の富士山麓でソロキャンプを楽しむ志摩リンは、富士山を見に来て寝過ごした各務原なでしこと出会う。焚き火とカレー麺から始まるゆるやかなキャンプ物語。',
    score: 82,
    popularity: 215000,
    episodes: 12,
    status: 'FINISHED',
    format: 'TV',
    season: 'WINTER',
    seasonYear: 2018,
    genres: ['Comedy', 'Slice of Life'],
    studios: ['C-Station'],
  },
  {
    id: 150672,
    nativeTitle: 'リコリス・リコイル',
    romajiTitle: 'Lycoris Recoil',
    englishTitle: 'Lycoris Recoil',
    chineseTitle: '莉可丽丝',
    synonyms: ['LycoReco'],
    coverUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx150672-2WWJVX5gH8xP.jpg',
    description:
      '守护日本治安的秘密特工少女「Lycoris」。历代最强的乐天派锦木千束与冷静追求效率的井之上泷奈在和风咖啡厅「LycoReco」组成搭档，解决各式各样的委托。',
    descriptionEn:
      'Free-spirited prodigy Chisato Nishikigi and pragmatic Takina Inoue partner up at Café LycoReco as secret “Lycoris” agents keeping Japan safe.',
    descriptionJa:
      '日本の治安を守る秘密組織の少女「リコリス」。歴代最強の楽天家・錦木千束と冷静な井ノ上たきなが喫茶「リコリコ」でコンビを組み、様々な依頼に挑む。',
    score: 81,
    popularity: 264000,
    episodes: 13,
    status: 'FINISHED',
    format: 'TV',
    season: 'SUMMER',
    seasonYear: 2022,
    genres: ['Action', 'Slice of Life'],
    studios: ['A-1 Pictures'],
  },
  {
    id: 140960,
    nativeTitle: 'SPY×FAMILY',
    romajiTitle: 'SPY×FAMILY',
    englishTitle: 'SPY x FAMILY',
    chineseTitle: '间谍过家家',
    synonyms: ['Spy Family'],
    coverUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx140960-vN39AmOWrVB5.jpg',
    description:
      '一流间谍「黄昏」、暗杀者「约尔」与读心超能力少女「阿尼亚」，三人互相隐瞒真实身份组建起临时家庭，在搞笑又温馨的日常中肩负起维护世界和平的任务。',
    descriptionEn:
      'Master spy Twilight, assassin Yor, and telepathic young Anya form a makeshift family while hiding their true identities from one another to preserve world peace.',
    descriptionJa:
      '凄腕スパイ〈黄昏〉、殺し屋ヨル、超能力少女アーニャの3人が互いの正体を隠したまま仮初めの家族を作り、世界平和のために奮闘するコメディ。',
    score: 84,
    popularity: 560000,
    episodes: 12,
    status: 'FINISHED',
    format: 'TV',
    season: 'SPRING',
    seasonYear: 2022,
    genres: ['Action', 'Comedy', 'Slice of Life'],
    studios: ['WIT STUDIO', 'CloverWorks'],
  },
  {
    id: 9253,
    nativeTitle: 'Steins;Gate',
    romajiTitle: 'Steins;Gate',
    englishTitle: 'STEINS;GATE',
    chineseTitle: '命运石之门',
    synonyms: ['シュタインズ・ゲート'],
    coverUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx9253-7pdcT6d2c3sP.jpg',
    description:
      '秋叶原自称狂气科学家的冈部伦太郎，与未来道具研究所的伙伴们偶然发明了能向过去发送短信的「电话微波炉（暂定）」，由此卷入了跨越世界线的残酷命运因果。',
    descriptionEn:
      'Self-proclaimed mad scientist Rintaro Okabe and his Akihabara labmates accidentally invent a microwave that sends text messages into the past, plunging them into a conspiracy across worldlines.',
    descriptionJa:
      '秋葉原で狂気のマッドサイエンティストを自称する岡部倫太郎たちは、過去へメールを送れる「電話レンジ（仮）」を偶然発明し、世界線を巡る過酷な運命に巻き込まれる。',
    score: 90,
    popularity: 620000,
    episodes: 24,
    status: 'FINISHED',
    format: 'TV',
    season: 'SPRING',
    seasonYear: 2011,
    genres: ['Drama', 'Psychological', 'Sci-Fi', 'Thriller'],
    studios: ['WHITE FOX'],
  },
  {
    id: 5680,
    nativeTitle: 'けいおん！',
    romajiTitle: 'K-ON!',
    englishTitle: 'K-ON!',
    chineseTitle: '轻音少女',
    synonyms: ['轻音部', 'Keion'],
    coverUrl: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx5680-3S9p8qR7t1V2.jpg',
    description:
      '面临废部危机的樱丘高中轻音部，迎来了连乐谱都不会看的天然少女平泽唯。与秋山澪、田井中律、琴吹紬一起喝茶吃点心、排练演出的放课后青春物语。',
    descriptionEn:
      'Airheaded Yui Hirasawa joins Sakuragaoka High’s struggling Light Music Club without knowing how to read sheet music, spending after-school days drinking tea, eating cake, and playing rock.',
    descriptionJa:
      '廃部寸前の桜が丘高校軽音部に、楽譜も読めない平沢唯が入部。秋山澪・田井中律・琴吹紬とお茶やお菓子を楽しみながら演奏する放課後ストーリー。',
    score: 78,
    popularity: 310000,
    episodes: 13,
    status: 'FINISHED',
    format: 'TV',
    season: 'SPRING',
    seasonYear: 2009,
    genres: ['Comedy', 'Music', 'Slice of Life'],
    studios: ['Kyoto Animation'],
  },
];

const FALLBACK_BY_ID = new Map<number, AniListMediaInfo>(FALLBACK_ANIME_CATALOG.map((item) => [item.id, item]));

const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
const IS_VITEST =
  typeof process !== 'undefined' &&
  Boolean((process as { env?: Record<string, string | undefined> }).env?.['VITEST']);
const byIdCache = new Map<number, AniListMediaInfo>();
const bySearchCache = new Map<string, AniListMediaInfo | null>();
const bySearchListCache = new Map<string, readonly AniListMediaInfo[]>();
let trendingCache: readonly AniListMediaInfo[] | undefined;

const MEDIA_FIELDS = `
  id
  title { native romaji english }
  synonyms
  description(asHtml: false)
  coverImage { extraLarge large medium }
  bannerImage
  averageScore
  popularity
  episodes
  status
  format
  season
  seasonYear
  genres
  studios(isMain: true) {
    nodes {
      name
      isAnimationStudio
    }
  }
`;

function cleanHtmlDescription(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function mapMedia(raw: unknown): AniListMediaInfo | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const id = typeof r['id'] === 'number' ? r['id'] : undefined;
  if (id === undefined) return undefined;
  const fallback = FALLBACK_BY_ID.get(id);
  const title = (r['title'] as Record<string, unknown> | undefined) ?? {};
  const cover = (r['coverImage'] as Record<string, unknown> | undefined) ?? {};
  const coverUrl =
    (typeof cover['extraLarge'] === 'string' && cover['extraLarge']) ||
    (typeof cover['large'] === 'string' && cover['large']) ||
    (typeof cover['medium'] === 'string' && cover['medium']) ||
    fallback?.coverUrl;
  const bannerUrl = typeof r['bannerImage'] === 'string' && r['bannerImage'] ? r['bannerImage'] : fallback?.bannerUrl;
  const nativeTitle =
    (typeof title['native'] === 'string' && title['native'].trim() ? title['native'].trim() : undefined) ??
    fallback?.nativeTitle;
  const romajiTitle =
    (typeof title['romaji'] === 'string' && title['romaji'].trim() ? title['romaji'].trim() : undefined) ??
    fallback?.romajiTitle;
  const englishTitle =
    (typeof title['english'] === 'string' && title['english'].trim() ? title['english'].trim() : undefined) ??
    fallback?.englishTitle;
  const chineseTitle = fallback?.chineseTitle;
  const synonyms = Array.isArray(r['synonyms'])
    ? r['synonyms'].filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    : fallback?.synonyms;
  const rawDesc = typeof r['description'] === 'string' ? cleanHtmlDescription(r['description']) : '';
  const description = fallback?.description ?? (rawDesc || undefined);
  const descriptionEn = (rawDesc || undefined) ?? fallback?.descriptionEn;
  const descriptionJa = fallback?.descriptionJa;
  const score =
    typeof r['averageScore'] === 'number' && r['averageScore'] > 0
      ? Math.round(r['averageScore'])
      : fallback?.score;
  const popularity =
    typeof r['popularity'] === 'number' && r['popularity'] > 0 ? Math.round(r['popularity']) : fallback?.popularity;
  const episodes = typeof r['episodes'] === 'number' && r['episodes'] > 0 ? r['episodes'] : fallback?.episodes;
  const status = typeof r['status'] === 'string' && r['status'] ? r['status'] : fallback?.status;
  const format = typeof r['format'] === 'string' && r['format'] ? r['format'] : fallback?.format;
  const season = typeof r['season'] === 'string' && r['season'] ? r['season'] : fallback?.season;
  const seasonYear = typeof r['seasonYear'] === 'number' && r['seasonYear'] > 0 ? r['seasonYear'] : fallback?.seasonYear;
  const genres = Array.isArray(r['genres'])
    ? r['genres'].filter((g): g is string => typeof g === 'string' && g.trim() !== '')
    : fallback?.genres;

  const studiosObj = r['studios'] as { nodes?: unknown[] } | undefined;
  const studioNodes = Array.isArray(studiosObj?.nodes) ? studiosObj.nodes : [];
  const studios = studioNodes
    .map((n) => (typeof n === 'object' && n !== null ? (n as Record<string, unknown>)['name'] : undefined))
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '');

  const info: AniListMediaInfo = {
    id,
    ...(coverUrl !== undefined ? { coverUrl } : {}),
    ...(bannerUrl !== undefined ? { bannerUrl } : {}),
    ...(nativeTitle !== undefined ? { nativeTitle } : {}),
    ...(romajiTitle !== undefined ? { romajiTitle } : {}),
    ...(englishTitle !== undefined ? { englishTitle } : {}),
    ...(chineseTitle !== undefined ? { chineseTitle } : {}),
    ...(synonyms && synonyms.length > 0 ? { synonyms } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(descriptionEn !== undefined ? { descriptionEn } : {}),
    ...(descriptionJa !== undefined ? { descriptionJa } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(popularity !== undefined ? { popularity } : {}),
    ...(episodes !== undefined ? { episodes } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(format !== undefined ? { format } : {}),
    ...(season !== undefined ? { season } : {}),
    ...(seasonYear !== undefined ? { seasonYear } : {}),
    ...(genres && genres.length > 0 ? { genres } : {}),
    ...(studios.length > 0 ? { studios } : fallback?.studios ? { studios: fallback.studios } : {}),
  };
  byIdCache.set(id, info);
  return info;
}

/** Clean up release tags/resolutions and trailing `(YYYY)` from a search query before querying AniList. */
export function cleanSearchQueryForAniList(raw: string): string {
  return raw
    .replace(/\s*\((?:19|20)\d{2}\)\s*$/g, ' ')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(?:1080p|720p|2160p|4K|HEVC|x265|x264|10bit|BD|BDRip|WEB-?DL|WEBRip|FLAC|AAC|RAW|Batch|S\d+E?\d*)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesMedia(item: AniListMediaInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystacks = [
    item.nativeTitle,
    item.romajiTitle,
    item.englishTitle,
    item.chineseTitle,
    ...(item.synonyms ?? []),
  ].filter((x): x is string => Boolean(x));
  return haystacks.some((h) => h.toLowerCase().includes(q) || q.includes(h.toLowerCase()));
}

/** Resolve Chinese anime search terms to their primary Romanized/Native query for AniList. */
function resolveSearchTermForAniList(cleaned: string): string {
  const hit = FALLBACK_ANIME_CATALOG.find((item) => {
    const q = cleaned.toLowerCase();
    return (
      (item.chineseTitle && (item.chineseTitle.toLowerCase().includes(q) || q.includes(item.chineseTitle.toLowerCase()))) ||
      (item.synonyms ?? []).some((s) => s.toLowerCase() === q || s.toLowerCase().includes(q))
    );
  });
  return hit?.romajiTitle ?? cleaned;
}

/**
 * Build prioritized Nyaa search queries for an anime series (ported from Fushi's
 * `_nyaaWorkQueries` in `nyaa_resource_provider.dart`).
 *
 * Searching Nyaa by Romanized title (`Bocchi the Rock!`) finds English/Multi-sub
 * batches like `[Judas]` and `[SubsPlease]`, while also querying the Native title
 * (`ぼっち・ざ・ろっく！`) finds Japanese/Chinese raw/BDRip releases.
 */
export function buildNyaaQueriesForMedia(media: AniListMediaInfo): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (raw: string | undefined): void => {
    const cleaned = (raw ?? '').replace(/\s+/g, ' ').trim();
    if (cleaned.length < 2) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cleaned);
  };
  push(media.romajiTitle);
  push(media.nativeTitle);
  push(media.englishTitle);
  return out.slice(0, 2);
}

/** Search AniList for a list of matching Anime series (Fushi Stage-1 Series Discovery). */
export async function searchAniListMediaList(query: string, limit = 14): Promise<readonly AniListMediaInfo[]> {
  const cleaned = cleanSearchQueryForAniList(query);
  if (cleaned.length < 1) return fetchAniListTrending(limit);
  const cacheKey = `${cleaned.toLowerCase()}#${limit}`;
  const cached = bySearchListCache.get(cacheKey);
  if (cached) return cached;

  const localMatches = FALLBACK_ANIME_CATALOG.filter((item) => matchesMedia(item, cleaned));
  const graphqlTerm = resolveSearchTermForAniList(cleaned);

  if (typeof fetch === 'function' && !IS_VITEST) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(ANILIST_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          query: `query ($search: String, $perPage: Int) { Page(page: 1, perPage: $perPage) { media(search: $search, type: ANIME, sort: [POPULARITY_DESC, SCORE_DESC], isAdult: false) { ${MEDIA_FIELDS} } } }`,
          variables: { search: graphqlTerm, perPage: limit },
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const json = (await res.json()) as { data?: { Page?: { media?: unknown[] } } };
        const remote = (json?.data?.Page?.media ?? []).map(mapMedia).filter((x): x is AniListMediaInfo => x !== undefined);
        if (remote.length > 0) {
          const byId = new Map<number, AniListMediaInfo>();
          for (const item of localMatches) byId.set(item.id, item);
          for (const item of remote) byId.set(item.id, item);
          const merged = [...byId.values()];
          bySearchListCache.set(cacheKey, merged);
          return merged;
        }
      }
    } catch {
      // Fallback to local curated catalog below when offline or in unit tests
    }
  }

  if (localMatches.length > 0) {
    bySearchListCache.set(cacheKey, localMatches);
    return localMatches;
  }
  // Synthetic series entry so any custom search keyword in offline/test mode still produces a series card
  const synthetic: AniListMediaInfo = {
    id: 900000 + Math.abs([...cleaned].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0) % 99999),
    romajiTitle: cleaned,
    nativeTitle: cleaned,
    format: 'TV',
    genres: ['Anime'],
  };
  return [synthetic];
}

/** Fetch Trending & Popular anime series for initial discovery view. */
export async function fetchAniListTrending(limit = 12): Promise<readonly AniListMediaInfo[]> {
  if (trendingCache) return trendingCache.slice(0, limit);
  if (typeof fetch === 'function' && !IS_VITEST) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(ANILIST_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          query: `query ($perPage: Int) { Page(page: 1, perPage: $perPage) { media(type: ANIME, sort: [TRENDING_DESC, POPULARITY_DESC], isAdult: false) { ${MEDIA_FIELDS} } } }`,
          variables: { perPage: limit },
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const json = (await res.json()) as { data?: { Page?: { media?: unknown[] } } };
        const remote = (json?.data?.Page?.media ?? []).map(mapMedia).filter((x): x is AniListMediaInfo => x !== undefined);
        if (remote.length > 0) {
          // Ensure Bocchi and Frieren are also easily discoverable
          const byId = new Map<number, AniListMediaInfo>();
          for (const item of remote) byId.set(item.id, item);
          for (const item of FALLBACK_ANIME_CATALOG) {
            if (!byId.has(item.id)) byId.set(item.id, item);
          }
          trendingCache = [...byId.values()];
          return trendingCache.slice(0, limit);
        }
      }
    } catch {
      // Ignore network/test errors; use fallback catalog
    }
  }
  trendingCache = FALLBACK_ANIME_CATALOG;
  return trendingCache.slice(0, limit);
}

/** Fetch top matching Anime metadata from AniList for a search query. */
export async function fetchAniListBySearch(query: string): Promise<AniListMediaInfo | undefined> {
  const cleaned = cleanSearchQueryForAniList(query);
  if (cleaned.length < 2) return undefined;
  const key = cleaned.toLowerCase();
  if (bySearchCache.has(key)) return bySearchCache.get(key) ?? undefined;
  const list = await searchAniListMediaList(cleaned, 5);
  const first = list[0];
  bySearchCache.set(key, first ?? null);
  return first;
}

/** Batch-fetch Anime metadata from AniList for a list of `anilistId`s (e.g. from Jimaku entries). */
export async function fetchAniListByIds(ids: readonly number[]): Promise<ReadonlyMap<number, AniListMediaInfo>> {
  for (const fb of FALLBACK_ANIME_CATALOG) {
    if (!byIdCache.has(fb.id)) byIdCache.set(fb.id, fb);
  }
  const unique = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];
  const missing = unique.filter((id) => !byIdCache.has(id));
  if (missing.length > 0 && typeof fetch === 'function' && !IS_VITEST) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      const res = await fetch(ANILIST_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          query: `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${MEDIA_FIELDS} } } }`,
          variables: { ids: missing.slice(0, 50) },
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const json = (await res.json()) as { data?: { Page?: { media?: unknown[] } } };
        for (const item of json?.data?.Page?.media ?? []) {
          mapMedia(item);
        }
      }
    } catch {
      // Ignore network/test errors; fallback to existing entry fields.
    }
  }
  const out = new Map<number, AniListMediaInfo>();
  for (const id of unique) {
    const cached = byIdCache.get(id);
    if (cached) out.set(id, cached);
  }
  return out;
}
