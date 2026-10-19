#!/usr/bin/env bun
/**
 * Moves inline base64 media from existing `session_message.data` rows into `media_blob`, then
 * optionally compacts the database into a new file. Safe to re-run: stored refs are skipped.
 *
 * Run only while the OpenCode server is stopped:
 *   bun packages/core/script/migrate-media-blobs.ts <path/to/opencode.db> [--vacuum-into <out.db>]
 */
import { Database } from "bun:sqlite"
import { SessionMediaBlob } from "../src/session/media-blob.js"

const args = process.argv.slice(2)
const dbPath = args.find((arg) => !arg.startsWith("--"))
const vacuumIdx = args.indexOf("--vacuum-into")
const vacuumTarget = vacuumIdx !== -1 ? args[vacuumIdx + 1] : undefined

if (!dbPath) {
  console.error("Usage: bun packages/core/script/migrate-media-blobs.ts <opencode.db> [--vacuum-into <out.db>]")
  process.exit(1)
}

const db = new Database(dbPath)
db.exec(`
  CREATE TABLE IF NOT EXISTS media_blob (
    hash TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    data TEXT NOT NULL,
    time_created INTEGER NOT NULL
  );
`)

const candidates = db
  .query<{ id: string }, []>(`SELECT id FROM session_message WHERE octet_length(data) >= 2048`)
  .all()

const selectRow = db.prepare<{ data: string }, [string]>(`SELECT data FROM session_message WHERE id = ?`)
const updateRow = db.prepare(`UPDATE session_message SET data = ? WHERE id = ?`)
const insertBlob = db.prepare(
  `INSERT OR IGNORE INTO media_blob (hash, mime, bytes, data, time_created) VALUES (?, ?, ?, ?, ?)`,
)

let migratedRows = 0
let blobsStored = 0
const batchSize = 250
const now = Date.now()

for (let offset = 0; offset < candidates.length; offset += batchSize) {
  db.transaction(() => {
    for (const { id } of candidates.slice(offset, offset + batchSize)) {
      const row = selectRow.get(id)
      if (!row || (!row.data.includes(";base64,") && !row.data.includes('"files"'))) continue
      const split = SessionMediaBlob.split(JSON.parse(row.data))
      if (split.blobs.length === 0) continue
      for (const blob of split.blobs)
        blobsStored += insertBlob.run(blob.hash, blob.mime, blob.data.length, blob.data, now).changes
      updateRow.run(JSON.stringify(split.data), id)
      migratedRows++
    }
  })()
}

if (vacuumTarget) db.exec(`VACUUM INTO '${vacuumTarget.replace(/'/g, "''")}';`)

db.close()
console.log(JSON.stringify({ candidates: candidates.length, migratedRows, blobsStored, vacuumTarget }))
