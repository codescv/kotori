-- Persist the per-task auto-import flag so re-queued tasks keep it after a restart.
ALTER TABLE download_tasks ADD COLUMN auto_import INTEGER NOT NULL DEFAULT 0;
