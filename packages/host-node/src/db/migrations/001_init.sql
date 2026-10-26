-- Kotori desktop schema v1 (ARCHITECTURE.md §5.2). node:sqlite, WAL, FK on.

CREATE TABLE IF NOT EXISTS settings (
  key  TEXT PRIMARY KEY,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS anime_series (
  id                      TEXT PRIMARY KEY,
  title                   TEXT NOT NULL,
  source_path             TEXT NOT NULL UNIQUE,
  cover_path              TEXT,
  added_at                INTEGER NOT NULL,
  last_watched_episode_id TEXT,
  last_watched_at         INTEGER,
  jimaku_entry_id         INTEGER,
  anilist_id              INTEGER
);

CREATE TABLE IF NOT EXISTS anime_episodes (
  id          TEXT PRIMARY KEY,
  series_id   TEXT NOT NULL REFERENCES anime_series(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  file_path   TEXT NOT NULL UNIQUE,
  container   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  duration_ms INTEGER,
  parsed_json TEXT NOT NULL,
  sort_index  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_episodes_series ON anime_episodes(series_id, sort_index);

CREATE TABLE IF NOT EXISTS subtitle_tracks (
  id           TEXT PRIMARY KEY,
  episode_id   TEXT NOT NULL REFERENCES anime_episodes(id) ON DELETE CASCADE,
  origin       TEXT NOT NULL,
  format       TEXT NOT NULL,
  label        TEXT NOT NULL,
  language     TEXT,
  file_path    TEXT,
  stream_index INTEGER,
  is_default   INTEGER NOT NULL DEFAULT 0,
  cue_count    INTEGER,
  delay_ms     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_episode ON subtitle_tracks(episode_id);

CREATE TABLE IF NOT EXISTS playback_progress (
  episode_id  TEXT PRIMARY KEY REFERENCES anime_episodes(id) ON DELETE CASCADE,
  position_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS manga_volumes (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  series_title    TEXT,
  volume_number   REAL,
  kind            TEXT NOT NULL,
  source_path     TEXT NOT NULL UNIQUE,
  root_dir        TEXT NOT NULL,
  page_count      INTEGER NOT NULL,
  has_ocr         INTEGER NOT NULL,
  reading_mode    TEXT,
  cover_is_single INTEGER NOT NULL DEFAULT 1,
  added_at        INTEGER NOT NULL,
  managed_dir     TEXT
);

CREATE TABLE IF NOT EXISTS manga_pages (
  volume_id     TEXT NOT NULL REFERENCES manga_volumes(id) ON DELETE CASCADE,
  page_index    INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  width         INTEGER NOT NULL,
  height        INTEGER NOT NULL,
  blocks_json   TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (volume_id, page_index)
);

CREATE TABLE IF NOT EXISTS manga_progress (
  volume_id  TEXT PRIMARY KEY REFERENCES manga_volumes(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS explanations (
  id              TEXT PRIMARY KEY,
  sentence        TEXT NOT NULL,
  target_language TEXT NOT NULL,
  model           TEXT NOT NULL,
  prompt_version  TEXT NOT NULL,
  json            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS follow_up_threads (
  explanation_id TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  message_id     TEXT NOT NULL,
  role           TEXT NOT NULL,
  text           TEXT NOT NULL,
  usage_json     TEXT,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (explanation_id, seq)
);

CREATE TABLE IF NOT EXISTS download_tasks (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL,
  json       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
