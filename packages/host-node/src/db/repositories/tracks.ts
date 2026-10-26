/** `subtitle_tracks` repository. */
import type { Id, LanguageTag, SubtitleFormat, SubtitleTrack, SubtitleTrackOrigin } from '@kotori/core';
import type { Database } from '../sqlite';
import { all, nullable, num, one, opt, optNum, optStr, run, type Row } from './util';

export interface TrackRecord {
  readonly id: Id;
  readonly episodeId: Id;
  readonly origin: SubtitleTrackOrigin;
  readonly format: SubtitleFormat;
  readonly label: string;
  readonly language?: LanguageTag;
  readonly filePath?: string;
  readonly streamIndex?: number;
  readonly isDefault?: boolean;
  readonly cueCount?: number;
  readonly delayMs?: number;
}

export class TrackRepository {
  constructor(private readonly db: Database) {}

  static map(r: Row): SubtitleTrack {
    return {
      id: String(r['id']),
      episodeId: String(r['episode_id']),
      origin: String(r['origin']) as SubtitleTrackOrigin,
      format: String(r['format']) as SubtitleFormat,
      label: String(r['label']),
      isDefault: num(r['is_default']) === 1,
      delayMs: num(r['delay_ms']),
      ...opt('language', optStr(r['language'])),
      ...opt('filePath', optStr(r['file_path'])),
      ...opt('streamIndex', optNum(r['stream_index'])),
      ...opt('cueCount', optNum(r['cue_count'])),
    };
  }

  get(id: Id): SubtitleTrack | undefined {
    const r = one(this.db, 'SELECT * FROM subtitle_tracks WHERE id = ?', id);
    return r ? TrackRepository.map(r) : undefined;
  }

  listByEpisode(episodeId: Id): SubtitleTrack[] {
    return all(this.db, 'SELECT * FROM subtitle_tracks WHERE episode_id = ? ORDER BY is_default DESC, created_at, label', episodeId).map(TrackRepository.map);
  }

  /** Insert or update (keeps user delay / default flag on conflict). */
  upsert(rec: TrackRecord, now: number = Date.now()): SubtitleTrack {
    run(
      this.db,
      `INSERT INTO subtitle_tracks (id, episode_id, origin, format, label, language, file_path, stream_index, is_default, cue_count, delay_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET origin = excluded.origin, format = excluded.format, label = excluded.label,
         language = excluded.language, file_path = excluded.file_path, stream_index = excluded.stream_index,
         cue_count = COALESCE(excluded.cue_count, subtitle_tracks.cue_count)`,
      rec.id,
      rec.episodeId,
      rec.origin,
      rec.format,
      rec.label,
      nullable(rec.language),
      nullable(rec.filePath),
      nullable(rec.streamIndex),
      rec.isDefault ? 1 : 0,
      nullable(rec.cueCount),
      rec.delayMs ?? 0,
      now,
    );
    const track = this.get(rec.id);
    if (!track) throw new Error(`track ${rec.id} vanished after upsert`);
    return track;
  }

  remove(id: Id): boolean {
    return run(this.db, 'DELETE FROM subtitle_tracks WHERE id = ?', id).changes > 0;
  }

  /** Remove tracks of an episode whose ids are not in `keep` and match `origin`. */
  pruneOrigin(episodeId: Id, origin: SubtitleTrackOrigin, keep: ReadonlySet<Id>): number {
    let removed = 0;
    for (const t of this.listByEpisode(episodeId)) {
      if (t.origin === origin && !keep.has(t.id)) removed += this.remove(t.id) ? 1 : 0;
    }
    return removed;
  }

  setDelay(id: Id, delayMs: number): void {
    run(this.db, 'UPDATE subtitle_tracks SET delay_ms = ? WHERE id = ?', Math.round(delayMs), id);
  }

  setCueCount(id: Id, cueCount: number): void {
    run(this.db, 'UPDATE subtitle_tracks SET cue_count = ? WHERE id = ?', cueCount, id);
  }

  setDefault(episodeId: Id, trackId: Id): void {
    run(this.db, 'UPDATE subtitle_tracks SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE episode_id = ?', trackId, episodeId);
  }

  hasDefault(episodeId: Id): boolean {
    return one(this.db, 'SELECT 1 AS x FROM subtitle_tracks WHERE episode_id = ? AND is_default = 1', episodeId) !== undefined;
  }
}
