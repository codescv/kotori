/** Repository bundle over one `node:sqlite` database. */
import type { Database } from '../sqlite';
import { DictionaryRepository } from './dictionaries';
import { DownloadRepository } from './downloads';
import { EpisodeRepository } from './episodes';
import { ExplanationRepository } from './explanations';
import { PageRepository } from './pages';
import { SeriesRepository } from './series';
import { ThreadRepository } from './threads';
import { TrackRepository } from './tracks';
import { VolumeRepository } from './volumes';

export interface Repositories {
  readonly series: SeriesRepository;
  readonly episodes: EpisodeRepository;
  readonly tracks: TrackRepository;
  readonly volumes: VolumeRepository;
  readonly pages: PageRepository;
  readonly explanations: ExplanationRepository;
  readonly threads: ThreadRepository;
  readonly downloads: DownloadRepository;
  readonly dictionaries: DictionaryRepository;
}

export function createRepositories(db: Database): Repositories {
  const dictionaries = new DictionaryRepository(db);
  // Half-finished dictionary imports (crash / quit mid-import) are never resumed.
  dictionaries.purgeIncompleteImports();
  return {
    series: new SeriesRepository(db),
    episodes: new EpisodeRepository(db),
    tracks: new TrackRepository(db),
    volumes: new VolumeRepository(db),
    pages: new PageRepository(db),
    explanations: new ExplanationRepository(db),
    threads: new ThreadRepository(db),
    downloads: new DownloadRepository(db),
    dictionaries,
  };
}

export { DictionaryRepository, DownloadRepository, EpisodeRepository, ExplanationRepository, PageRepository, SeriesRepository, ThreadRepository, TrackRepository, VolumeRepository };
export type { EpisodeRecord } from './episodes';
export type { SeriesRecord } from './series';
export type { TrackRecord } from './tracks';
export type { VolumeRecord } from './volumes';
export type { PageRecord } from './pages';
