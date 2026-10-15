-- SyncNote schema for Neon Postgres. Run once (Render deploy or psql).
-- One table, soft deletes: a row with deleted_at IS NULL is alive,
-- a row with deleted_at NOT NULL is deleted but kept so other devices learn about it.

CREATE TABLE IF NOT EXISTS notes (
  id            TEXT PRIMARY KEY,  -- client-generated ID, same on every device
  user_id       TEXT NOT NULL,     -- demo single-user column (filters every query)
  title         TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DE
  FAULT '',
  created_at    BIGINT NOT NULL,   -- first-seen server time (ms since epoch)
  updated_at    BIGINT NOT NULL,   -- client's edit time (ms since epoch)
  last_modified BIGINT NOT NULL,   -- server ordering clock: pull/push cursor
  deleted_at    BIGINT NULL        -- NULL = alive, number = soft-deleted at this ms
);

-- Fast "what changed since X?" lookups for pullChanges().
CREATE INDEX IF NOT EXISTS idx_notes_user_modified
  ON notes (user_id, last_modified);
