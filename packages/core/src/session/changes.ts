export * as SessionChanges from "./changes.js"

import { and, asc, eq, gt, lte, sql } from "drizzle-orm"
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { MessageDecodeError, NotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { SessionInbox } from "./inbox.js"
import * as SessionInfo from "./info.js"
import type { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"
import { SessionInboxTable, SessionMessageTable, SessionPartTable, SessionTable, SessionTombstoneTable } from "./sql.js"

/*
 * Every write to a session's state rows (session_v2, session_message, session_part, session_inbox) stamps
 * `change_seq` with the session's durable event sequence of the transaction that wrote it, and every delete leaves a
 * tombstone at that sequence. Rows written in one transaction share a change number, and a later transaction always
 * takes a higher one, so "rows with change_seq > N" plus tombstones is everything that changed after the client's
 * cursor N, each row once at its latest version. `seq` on session_message stays creation order.
 */

type DatabaseService = Database.Interface["db"]

export type TombstoneKind = (typeof SessionTombstoneTable.$inferSelect)["kind"]

export type TombstoneKey = {
  readonly kind: TombstoneKind
  readonly rowID: SessionMessage.ID
  readonly ordinal?: number
}

const BatchSize = 500
export const DefaultLimit = 500
export const MaxLimit = 5000

/** Record removed rows at `changeSeq`. Removing a message removes its parts, which need no tombstones. */
export const tombstone = Effect.fnUntraced(function* (
  db: Pick<DatabaseService, "insert">,
  sessionID: SessionSchema.ID,
  changeSeq: number,
  keys: ReadonlyArray<TombstoneKey>,
) {
  for (let index = 0; index < keys.length; index += BatchSize) {
    yield* db
      .insert(SessionTombstoneTable)
      .values(
        keys.slice(index, index + BatchSize).map((key) => ({
          session_id: sessionID,
          kind: key.kind,
          row_id: key.rowID,
          ordinal: key.ordinal ?? 0,
          change_seq: changeSeq,
        })),
      )
      .onConflictDoUpdate({
        target: [
          SessionTombstoneTable.session_id,
          SessionTombstoneTable.kind,
          SessionTombstoneTable.row_id,
          SessionTombstoneTable.ordinal,
        ],
        set: { change_seq: changeSeq },
      })
      .run()
      .pipe(Effect.orDie)
  }
})

/**
 * Take the session's next change number for a write made outside one of its own events. Must run inside the
 * writing transaction.
 */
export const reserve = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const next = (yield* Bus.latestSequence(db, sessionID)) + 1
  yield* Bus.reserveSequence(db, sessionID, next)
  return next
})

export type Change =
  | { readonly type: "session"; readonly seq: number; readonly session: SessionSchema.Info }
  | { readonly type: "message"; readonly seq: number; readonly message: SessionMessage.Info }
  | {
      readonly type: "part"
      readonly seq: number
      readonly messageID: SessionMessage.ID
      readonly ordinal: number
      readonly part: SessionMessage.AssistantContent
    }
  | { readonly type: "inbox"; readonly seq: number; readonly item: SessionInbox.Info }
  | {
      readonly type: "removed"
      readonly seq: number
      readonly kind: TombstoneKind
      readonly id: SessionMessage.ID
      readonly ordinal?: number
    }

export type Page = {
  readonly sessionID: SessionSchema.ID
  /** The session's latest change number when the page was read. */
  readonly head: number
  /** Every change after `since` through this number is in the page. Use it as the next cursor. */
  readonly through: number
  readonly more: boolean
  readonly changes: ReadonlyArray<Change>
}

// Within one change number removals apply first, and a message before its parts.
const rank: Record<Change["type"], number> = { removed: 0, session: 1, message: 2, part: 3, inbox: 4 }

const compare = (a: Change, b: Change) => {
  if (a.seq !== b.seq) return a.seq - b.seq
  if (a.type !== b.type) return rank[a.type] - rank[b.type]
  if (a.type === "part" && b.type === "part") {
    if (a.messageID !== b.messageID) return a.messageID < b.messageID ? -1 : 1
    return a.ordinal - b.ordinal
  }
  return 0
}

/**
 * Read the changes after `since` in one read transaction. A page holds about `limit` rows but never splits a change
 * number, so it may run over when one transaction wrote many rows (a fork or an import).
 */
export const read = Effect.fnUntraced(function* (
  db: DatabaseService,
  input: { readonly sessionID: SessionSchema.ID; readonly since?: number; readonly limit?: number },
) {
  const since = input.since ?? -1
  const limit = Math.min(Math.max(input.limit ?? DefaultLimit, 1), MaxLimit)
  const sessionID = input.sessionID
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const session = yield* db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        if (!session) return yield* new NotFoundError({ sessionID })
        // Rows copied from v1 sessions with no events yet sit at 0.
        const head = Math.max(yield* Bus.latestSequence(db, sessionID), 0)

        // A page ends at the change number of its `limit`-th row, taken from each table's first `limit` numbers.
        const seqs = (session: AnySQLiteColumn, seq: AnySQLiteColumn, table: SQLiteTable) =>
          db
            .select({ seq: sql<number>`${seq}` })
            .from(table)
            .where(and(eq(session, sessionID), gt(seq, since)))
            .orderBy(asc(seq))
            .limit(limit)
            .all()
            .pipe(
              Effect.orDie,
              Effect.map((rows) => rows.map((row) => row.seq)),
            )
        const candidates = [
          ...(session.change_seq > since ? [session.change_seq] : []),
          ...(yield* seqs(SessionMessageTable.session_id, SessionMessageTable.change_seq, SessionMessageTable)),
          ...(yield* seqs(SessionPartTable.session_id, SessionPartTable.change_seq, SessionPartTable)),
          ...(yield* seqs(SessionInboxTable.session_id, SessionInboxTable.change_seq, SessionInboxTable)),
          ...(yield* seqs(SessionTombstoneTable.session_id, SessionTombstoneTable.change_seq, SessionTombstoneTable)),
        ].sort((a, b) => a - b)
        const end = candidates.length >= limit ? candidates[limit - 1]! : head
        // Rows can sit below the head (forks, imports, v1 copies), so a full page may already hold the last change.
        const after = (session: AnySQLiteColumn, seq: AnySQLiteColumn, table: SQLiteTable) =>
          db
            .select({ seq: sql<number>`${seq}` })
            .from(table)
            .where(and(eq(session, sessionID), gt(seq, end)))
            .limit(1)
            .get()
            .pipe(
              Effect.orDie,
              Effect.map((row) => row !== undefined),
            )
        const remaining =
          end < head &&
          (session.change_seq > end ||
            candidates.some((seq) => seq > end) ||
            (yield* after(SessionMessageTable.session_id, SessionMessageTable.change_seq, SessionMessageTable)) ||
            (yield* after(SessionPartTable.session_id, SessionPartTable.change_seq, SessionPartTable)) ||
            (yield* after(SessionInboxTable.session_id, SessionInboxTable.change_seq, SessionInboxTable)) ||
            (yield* after(SessionTombstoneTable.session_id, SessionTombstoneTable.change_seq, SessionTombstoneTable)))
        // A cursor past the head (a stale or foreign one) never moves backwards.
        const through = Math.max(remaining ? end : head, since)
        const range = (session: AnySQLiteColumn, seq: AnySQLiteColumn) =>
          and(eq(session, sessionID), gt(seq, since), lte(seq, through))

        const messageRows = yield* db
          .select()
          .from(SessionMessageTable)
          .where(range(SessionMessageTable.session_id, SessionMessageTable.change_seq))
          .orderBy(asc(SessionMessageTable.change_seq), asc(SessionMessageTable.seq))
          .all()
          .pipe(Effect.orDie)
        const partRows = yield* db
          .select()
          .from(SessionPartTable)
          .where(range(SessionPartTable.session_id, SessionPartTable.change_seq))
          .all()
          .pipe(Effect.orDie)
        const inboxRows = yield* db
          .select()
          .from(SessionInboxTable)
          .where(range(SessionInboxTable.session_id, SessionInboxTable.change_seq))
          .all()
          .pipe(Effect.orDie)
        const removedRows = yield* db
          .select()
          .from(SessionTombstoneTable)
          .where(range(SessionTombstoneTable.session_id, SessionTombstoneTable.change_seq))
          .all()
          .pipe(Effect.orDie)

        const changes: Change[] = []
        if (session.change_seq > since && session.change_seq <= through)
          changes.push({ type: "session", seq: session.change_seq, session: SessionInfo.fromRow(session) })
        for (const row of messageRows) {
          const message = yield* SessionHistory.decodeMessageRow(row)
          if (message.type === "assistant" && message.content.length > 0) {
            // A legacy row still holds its parts inline; send them as the part rows a split would write.
            changes.push({ type: "message", seq: row.change_seq, message: { ...message, content: [] } })
            message.content.forEach((part, ordinal) =>
              changes.push({ type: "part", seq: row.change_seq, messageID: message.id, ordinal, part }),
            )
            continue
          }
          changes.push({ type: "message", seq: row.change_seq, message })
        }
        for (const row of partRows) {
          const part = yield* Effect.try({
            try: () => SessionHistory.decodePartRowSync(row),
            catch: () => new MessageDecodeError({ sessionID, messageID: row.message_id }),
          })
          changes.push({ type: "part", seq: row.change_seq, messageID: row.message_id, ordinal: row.ordinal, part })
        }
        for (const row of inboxRows)
          changes.push({ type: "inbox", seq: row.change_seq, item: SessionInbox.fromRow(row) })
        for (const row of removedRows)
          changes.push({
            type: "removed",
            seq: row.change_seq,
            kind: row.kind,
            id: row.row_id,
            ...(row.kind === "part" ? { ordinal: row.ordinal } : {}),
          })
        changes.sort(compare)
        return { sessionID, head, through, more: through < head, changes } satisfies Page
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

export class DisabledError extends Schema.TaggedError<DisabledError>()("SessionChanges.DisabledError", {}) {
  override get message() {
    return "Session change feed is disabled. Start the server with OPENCODE_EXPERIMENTAL_SYNC=1."
  }
}

export interface Interface {
  readonly enabled: boolean
  readonly read: (input: {
    readonly sessionID: SessionSchema.ID
    readonly since?: number
    readonly limit?: number
  }) => Effect.Effect<Page, DisabledError | NotFoundError | MessageDecodeError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionChanges") {}

export function configured(options?: { readonly enabled?: boolean }) {
  return makeGlobalNode({
    service: Service,
    deps: [Database.node],
    layer: Layer.effect(
      Service,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const enabled = options?.enabled ?? false
        return Service.of({
          enabled,
          read: (input) => (enabled ? read(db, input) : Effect.fail(new DisabledError())),
        })
      }),
    ),
  })
}

export const node = configured()
