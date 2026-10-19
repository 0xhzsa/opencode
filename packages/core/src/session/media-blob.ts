export * as SessionMediaBlob from "./media-blob.js"

import { createHash } from "node:crypto"
import { inArray } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
import { MediaBlobTable, SessionMessageTable } from "./sql.js"

type DatabaseService = Database.Interface["db"]
type Row = typeof SessionMessageTable.$inferSelect
type Data = Row["data"]

const PREFIX = "blob:sha256:"
const MIN_BYTES = 1_024

export type Blob = { readonly hash: string; readonly mime: string; readonly data: string }

const hashOf = (ref: string) => (ref.startsWith(PREFIX) ? ref.slice(PREFIX.length) : undefined)

/**
 * Maps each stored media payload: a user file's base64 `data`, or the base64 of a completed tool
 * file whose URI is `data:<mime>;base64,…`. Refs are passed through as-is. Returns `data` when unchanged.
 */
function mapMedia(data: Data, f: (payload: string, mime: string) => string): Data {
  if ("files" in data && data.files) {
    let changed = false
    const files = data.files.map((file) => {
      const next = f(file.data, file.mime)
      if (next === file.data) return file
      changed = true
      return { ...file, data: next }
    })
    return changed ? { ...data, files } : data
  }
  if (!("content" in data)) return data
  let changed = false
  const content = data.content.map((part) => {
    if (part.type !== "tool" || (part.state.status !== "completed" && part.state.status !== "error")) return part
    if (!part.state.content) return part
    let partChanged = false
    const items = part.state.content.map((item) => {
      if (item.type !== "file") return item
      const prefix = `data:${item.mime};base64,`
      const payload = item.uri.startsWith(PREFIX)
        ? item.uri
        : item.uri.startsWith(prefix)
          ? item.uri.slice(prefix.length)
          : undefined
      if (payload === undefined) return item
      const next = f(payload, item.mime)
      if (next === payload) return item
      partChanged = true
      return { ...item, uri: next.startsWith(PREFIX) ? next : prefix + next }
    })
    if (!partChanged) return part
    changed = true
    return { ...part, state: { ...part.state, content: [items[0]!, ...items.slice(1)] as const } }
  })
  return changed ? { ...data, content } : data
}

/** Replaces inline media of at least 1 KiB with `blob:sha256:<hash>` refs and returns the blobs to store. */
export function split(data: Data): { readonly data: Data; readonly blobs: ReadonlyArray<Blob> } {
  const blobs = new Map<string, Blob>()
  const next = mapMedia(data, (payload, mime) => {
    if (payload.startsWith(PREFIX) || payload.length < MIN_BYTES) return payload
    const hash = createHash("sha256").update(payload).digest("hex")
    blobs.set(hash, { hash, mime, data: payload })
    return PREFIX + hash
  })
  return { data: next, blobs: [...blobs.values()] }
}

/** Stores inline media as blobs and returns the row data to persist. Run inside the row's write transaction. */
export const externalize = Effect.fnUntraced(function* (db: DatabaseService, data: Data) {
  const result = split(data)
  if (result.blobs.length > 0)
    yield* db
      .insert(MediaBlobTable)
      .values(result.blobs.map((blob) => ({ ...blob, bytes: blob.data.length })))
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  return result.data
})

/** Restores the original media for any blob refs in `rows`. Rows without refs are returned untouched. */
export const hydrate = Effect.fnUntraced(function* (db: DatabaseService, rows: ReadonlyArray<Row>) {
  const hashes = new Set<string>()
  for (const row of rows)
    mapMedia(row.data, (payload) => {
      const hash = hashOf(payload)
      if (hash) hashes.add(hash)
      return payload
    })
  if (hashes.size === 0) return rows

  const all = [...hashes]
  const blobs = new Map<string, string>()
  for (let offset = 0; offset < all.length; offset += 500) {
    const found = yield* db
      .select({ hash: MediaBlobTable.hash, data: MediaBlobTable.data })
      .from(MediaBlobTable)
      .where(inArray(MediaBlobTable.hash, all.slice(offset, offset + 500)))
      .all()
      .pipe(Effect.orDie)
    for (const blob of found) blobs.set(blob.hash, blob.data)
  }

  return rows.map((row) => {
    const data = mapMedia(row.data, (payload) => blobs.get(hashOf(payload) ?? "") ?? payload)
    return data === row.data ? row : { ...row, data }
  })
})
