/** `anime_episodes` + `playback_progress` repository. */
import type { AnimeEpisode, Id, ParsedEpisodeName, PlaybackProgress, VideoContainer } from '@kotori/core';
import { mediaUrlFor } from '../../shared/routes';
import type { Database } from '../sqlite';
import { TrackRepository } from './tracks';
import { all, nullable, num, one, opt, optNum, run, type Row } from './util';

export interface EpisodeRecord {
  readonly id: Id;
  readonly seriesId: Id;
  readonly title: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly container: VideoContainer;
  readonly sizeBytes: number;
  readonly durationMs?: number;
  readonly parsedName: ParsedEpisodeName;
  readonly sortIndex: number;
}

const SELECT = `SELECT e.*, p.position_ms, p.duration_ms AS progress_duration_ms, p.updated_at AS progress_updated_at
  FROM anime_episodes e LEFT JOIN playback_progress p ON p.episode_id = e.id`;

export class EpisodeRepository {
  private readonly tracks: TrackRepository;

  constructor(private readonly db: Database) {
    this.tracks = new TrackRepository(db);
  }

  private map(r: Row): AnimeEpisode {
    const id = String(r['id']);
    const progress: PlaybackProgress | undefined =
      r['position_ms'] === null || r['position_ms'] === undefined
        ? undefined
        : { positionMs: num(r['position_ms']), durationMs: num(r['progress_duration_ms']), updatedAt: num(r['progress_updated_at']) };
    return {
      id,
      seriesId: String(r['series_id']),
      title: String(r['title']),
      fileName: String(r['file_name']),
      filePath: String(r['file_path']),
      container: String(r['container']) as VideoContainer,
      sizeBytes: num(r['size_bytes']),
      parsedName: JSON.parse(String(r['parsed_json'])) as ParsedEpisodeName,
      subtitleTracks: this.tracks.listByEpisode(id),
      mediaUrl: mediaUrlFor(id),
      ...opt('durationMs', optNum(r['duration_ms'])),
      ...opt('progress', progress),
    };
  }

  get(id: Id): AnimeEpisode | undefined {
    const r = one(this.db, `${SELECT} WHERE e.id = ?`, id);
    return r ? this.map(r) : undefined;
  }

  listBySeries(seriesId: Id): AnimeEpisode[] {
    return all(this.db, `${SELECT} WHERE e.series_id = ? ORDER BY e.sort_index, e.file_name`, seriesId).map((r) => this.map(r));
  }

  idsBySeries(seriesId: Id): Id[] {
    return all(this.db, 'SELECT id FROM anime_episodes WHERE series_id = ?', seriesId).map((r) => String(r['id']));
  }

  upsert(rec: EpisodeRecord): void {
    run(
      this.db,
      `INSERT INTO anime_episodes (id, series_id, title, file_name, file_path, container, size_bytes, duration_ms, parsed_json, sort_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET series_id = excluded.series_id, title = excluded.title, file_name = excluded.file_name,
         file_path = excluded.file_path, container = excluded.container, size_bytes = excluded.size_bytes,
         duration_ms = COALESCE(excluded.duration_ms, anime_episodes.duration_ms), parsed_json = excluded.parsed_json,
         sort_index = excluded.sort_index`,
      rec.id,
      rec.seriesId,
      rec.title,
      rec.fileName,
      rec.filePath,
      rec.container,
      rec.sizeBytes,
      nullable(rec.durationMs),
      JSON.stringify(rec.parsedName),
      rec.sortIndex,
    );
  }

  remove(id: Id): boolean {
    return run(this.db, 'DELETE FROM anime_episodes WHERE id = ?', id).changes > 0;
  }

  saveProgress(id: Id, progress: PlaybackProgress): void {
    run(
      this.db,
      `INSERT INTO playback_progress (episode_id, position_ms, duration_ms, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(episode_id) DO UPDATE SET position_ms = excluded.position_ms, duration_ms = excluded.duration_ms, updated_at = excluded.updated_at`,
      id,
      Math.round(progress.positionMs),
      Math.round(progress.durationMs),
      progress.updatedAt,
    );
    if (progress.durationMs > 0) {
      run(this.db, 'UPDATE anime_episodes SET duration_ms = ? WHERE id = ? AND duration_ms IS NULL', Math.round(progress.durationMs), id);
    }
  }
}
