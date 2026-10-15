// This file holds ALL sync logic: two functions, pullChanges + pushChanges.
// Strategy: "last-write-wins" on a single `notes` table with soft deletes.
// There is no sync_clock table and no conflict errors —
// whoever writes last wins, which keeps every line easy to follow.

// ---------------------------------------------------------------------------
// Line 1-4: Shapes of the data. The app (WatermelonDB) always sends and
// receives notes grouped as { created, updated, deleted }.
// - created/updated carry full note objects.
// - deleted carries only IDs (the app hard-deletes locally, we soft-delete).
// ---------------------------------------------------------------------------
export interface NoteRecord {
  id: string;
  title: string;
  body: string;
  updated_at: number; // client-side edit time (milliseconds)
  deleted_at: number | null; // null = alive, number = soft-deleted at this time
}

export interface NoteChanges {
  created: NoteRecord[];
  updated: NoteRecord[];
  deleted: string[];
}

export interface SyncChanges {
  notes: NoteChanges;
}

export interface PullResult {
  changes: SyncChanges;
  timestamp: number; // server clock the client should send back next time
}

// One row as Postgres returns it (numbers may arrive as strings).
interface DatabaseNote {
  id: string;
  title: string;
  body: string;
  updated_at: string | number;
  deleted_at: string | number | null;
  last_modified: string | number;
}

// Line 5: Single demo user so the tutorial needs no auth.
// Every query filters by this, keeping each user's notes separate.
import { pool } from "./db";

const DEMO_USER_ID = process.env.DEMO_USER_ID ?? "demo-user";

// ---------------------------------------------------------------------------
// pullChanges(lastPulledAt): "give me everything that changed since last time"
// ---------------------------------------------------------------------------
export async function pullChanges(lastPulledAt: number): Promise<PullResult> {
  // Line 1: Ask Postgres for every note of this user touched after lastPulledAt.
  // last_modified is the SERVER ordering clock (set on every push).
  const result = await pool.query<DatabaseNote>(
    `SELECT id, title, body, updated_at, deleted_at, last_modified
     FROM notes
     WHERE user_id = $1 AND last_modified > $2
     ORDER BY last_modified ASC`,
    [DEMO_USER_ID, lastPulledAt],
  );

  // Line 2: Prepare the three buckets the app understands.
  // We always leave `created` empty and put every live note in `updated` —
  // WatermelonDB applies both the same way, so one bucket is enough to learn.
  const updated: NoteRecord[] = [];
  const deleted: string[] = [];

  // Line 3: Sort each row into a bucket.
  for (const row of result.rows) {
    // A non-null deleted_at means "soft-deleted": tell the app to remove the ID.
    if (row.deleted_at !== null) {
      deleted.push(row.id);
      continue;
    }
    // Otherwise it's a live note the app should create-or-update locally.
    updated.push({
      id: row.id,
      title: row.title,
      body: row.body,
      updated_at: Number(row.updated_at),
      deleted_at: null,
    });
  }

  // Line 4: The new cursor is the biggest last_modified we just saw.
  // If nothing changed, keep the old cursor so the clock never goes backwards.
  let timestamp = lastPulledAt;
  for (const row of result.rows) {
    timestamp = Math.max(timestamp, Number(row.last_modified));
  }

  // Line 5: WatermelonDB rejects timestamp 0 ("must be a non-zero number"),
  // and an empty database would return exactly that — so fall back to the
  // server clock. The cursor stays exact whenever rows exist; it only jumps
  // to "now" when there was nothing to see.
  if (!timestamp) {
    timestamp = Date.now();
  }

  // Line 6: Return WatermelonDB-shaped changes plus the new cursor.
  return { changes: { notes: { created: [], updated, deleted } }, timestamp };
}

// ---------------------------------------------------------------------------
// pushChanges(changes): "here are my local edits, save them"
// Last-write-wins: we overwrite whatever is on the server, no conflict errors.
// ---------------------------------------------------------------------------
export async function pushChanges(changes: SyncChanges): Promise<void> {
  // Line 1: Merge created + updated — both are just "upsert this note".
  const upserts = [...changes.notes.created, ...changes.notes.updated];

  // Line 2: A shared millisecond cursor so every note in this push gets a
  // unique, increasing last_modified even if Date.now() repeats a millisecond.
  let clock = Date.now();

  // Line 3: Save each note. INSERT adds new rows; ON CONFLICT updates existing
  // rows. The `WHERE notes.user_id = ...` guard stops one user overwriting
  // another user's row with the same id.
  for (const note of upserts) {
    const modifiedAt = clock++;
    await pool.query(
      `INSERT INTO notes (
         id, user_id, title, body, created_at, updated_at, last_modified, deleted_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         body = EXCLUDED.body,
         updated_at = EXCLUDED.updated_at,
         last_modified = EXCLUDED.last_modified,
         deleted_at = EXCLUDED.deleted_at
       WHERE notes.user_id = EXCLUDED.user_id`,
      [
        note.id, // $1: client-generated ID, same on every device
        DEMO_USER_ID, // $2: owner
        note.title, // $3
        note.body, // $4
        modifiedAt, // $5 created_at: first-seen server time
        note.updated_at, // $6 updated_at: client's edit time (kept as-is)
        modifiedAt, // $7 last_modified: server ordering clock
        note.deleted_at, // $8 null = alive, number = soft-deleted
      ],
    );
  }

  // Line 4: Handle hard-deletes from the app (IDs only, no title/body).
  // We UPDATE the row to a soft-delete instead of DELETE-ing it, so other
  // devices learn about the deletion on their next pull. If the row never
  // existed on the server (created + deleted offline before first push),
  // the UPDATE matches 0 rows and there is nothing to do.
  for (const id of changes.notes.deleted) {
    const modifiedAt = clock++;
    await pool.query(
      `UPDATE notes
       SET deleted_at = $1, last_modified = $1
       WHERE id = $2 AND user_id = $3`,
      [modifiedAt, id, DEMO_USER_ID],
    );
  }
}
