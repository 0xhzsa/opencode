export * as SessionProjector from "./projector.js"

import { produce } from "immer"
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import path from "path"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Model } from "@opencode/schema/model"
import { SessionEvent } from "./event.js"
import { SessionMessage } from "./message.js"
import { SessionMessageUpdater } from "./message-updater.js"
import { SessionInbox } from "./inbox.js"
import { InstructionState } from "./instruction-state.js"
import { SessionInboxTable, SessionMessageTable, SessionPartTable, SessionTable } from "./sql.js"
import { SessionChanges } from "./changes.js"
import { InstructionEntry } from "./instruction-entry.js"
import { Slug } from "../util/slug.js"
import { FSUtil } from "@opencode/util/fs-util"
import { Money } from "@opencode/schema/money"
import type { TokenUsage } from "@opencode/schema/token-usage"
import { Worktree } from "@opencode/schema/worktree"
import { Project } from "@opencode/schema/project"
import { AbsolutePath, RelativePath } from "../schema.js"
import type { SessionSchema } from "./schema.js"
import { SessionHistory } from "./history.js"
import { ProjectTable } from "../project/sql.js"

type DatabaseService = Database.Interface["db"]
type MessageEvent = Exclude<
  SessionEvent.DurableEvent,
  typeof SessionEvent.Forked.Type | typeof SessionEvent.Deleted.Type
>

const encodeMessage = Schema.encodeSync(SessionMessage.Info)

export class SessionAlreadyProjected extends Error {}

type Usage = {
  cost: number
  tokens: TokenUsage.Info
}

const ForkBatchSize = 500

const forkTitle = (value?: string) => {
  if (value === undefined) return
  const match = value.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) return `${match[1]} (fork #${Number.parseInt(match[2], 10) + 1})`
  return `${value} (fork #1)`
}

function applyUsage(
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  changeSeq: number,
  value: Usage,
  timeUpdated?: number,
) {
  return db
    .update(SessionTable)
    .set({
      change_seq: changeSeq,
      cost: sql`${SessionTable.cost} + ${value.cost}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write}`,
      time_updated: timeUpdated ?? sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

function touch(db: DatabaseService, event: MessageEvent) {
  return db
    .update(SessionTable)
    .set({ time_updated: event.created, change_seq: event.durable.seq })
    .where(eq(SessionTable.id, event.data.sessionID))
    .run()
    .pipe(Effect.orDie)
}

const publishSessionUsage = Effect.fn("SessionProjector.publishUsage")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({
      cost: SessionTable.cost,
      input: SessionTable.tokens_input,
      output: SessionTable.tokens_output,
      reasoning: SessionTable.tokens_reasoning,
      cacheRead: SessionTable.tokens_cache_read,
      cacheWrite: SessionTable.tokens_cache_write,
    })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!row) return
  yield* bus.publish(SessionEvent.UsageUpdated, {
    sessionID,
    cost: Money.USD.make(row.cost),
    tokens: {
      input: row.input,
      output: row.output,
      reasoning: row.reasoning,
      cache: { read: row.cacheRead, write: row.cacheWrite },
    },
  })
})

const projectFork = Effect.fn("SessionProjector.projectFork")(function* (
  db: DatabaseService,
  event: typeof SessionEvent.Forked.Type,
) {
  const parent = yield* db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, event.data.parentID))
    .get()
    .pipe(Effect.orDie)
  if (!parent) return yield* Effect.die(new Error(`Fork parent session not found: ${event.data.parentID}`))
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, event.data.parentID),
        eq(SessionMessageTable.id, event.data.boundary.messageID),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!boundary)
    return yield* Effect.die(new Error(`Fork boundary message not found: ${event.data.boundary.messageID}`))
  const copied = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, event.data.parentID),
        event.data.boundary.type === "before"
          ? lt(SessionMessageTable.seq, boundary.seq)
          : lte(SessionMessageTable.seq, boundary.seq),
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const copiedSeq = copied?.seq

  const stored = yield* db
    .insert(SessionTable)
    .values({
      id: event.data.sessionID,
      parent_id: null,
      fork_session_id: event.data.parentID,
      fork_boundary: event.data.boundary,
      project_id: parent.project_id,
      workspace_id: parent.workspace_id,
      slug: Slug.create(),
      directory: parent.directory,
      path: parent.path,
      title: forkTitle(parent.title ?? undefined),
      agent: parent.agent,
      model: parent.model,
      metadata: parent.metadata,
      permission: parent.permission,
      version: parent.version,
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      time_created: event.created,
      time_updated: event.created,
      change_seq: event.durable.seq,
    })
    .onConflictDoNothing()
    .returning({ sessionID: SessionTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new SessionAlreadyProjected())

  if (event.data.instructionEntries)
    yield* InstructionEntry.initialize(db, event.data.sessionID, event.data.instructionEntries, event.created)

  const forkedID = (seq: number) => SessionMessage.ID.make(`${SessionMessage.ID.fromEvent(event.id)}_${seq}`)
  let cursor = -1
  while (copiedSeq !== undefined) {
    const rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, event.data.parentID),
          gt(SessionMessageTable.seq, cursor),
          lt(SessionMessageTable.seq, copiedSeq + 1),
          // Terminal events for active projections stay on the parent, so forks copy only settled history.
          sql`${SessionMessageTable.type} != 'assistant' or json_extract(${SessionMessageTable.data}, '$.time.completed') is not null`,
          sql`${SessionMessageTable.type} != 'shell' or json_extract(${SessionMessageTable.data}, '$.status') != 'running'`,
          sql`${SessionMessageTable.type} != 'compaction' or json_extract(${SessionMessageTable.data}, '$.status') != 'running'`,
        ),
      )
      .orderBy(asc(SessionMessageTable.seq))
      .limit(ForkBatchSize)
      .all()
      .pipe(Effect.orDie)
    if (rows.length === 0) break

    const values = yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const copy = {
          id: forkedID(row.seq),
          session_id: event.data.sessionID,
          type: row.type,
          seq: row.seq,
          change_seq: event.durable.seq,
          time_created: row.time_created,
          time_updated: row.time_updated,
          data:
            row.type === "assistant" && SessionHistory.hasInlineContent(row.data)
              ? { ...row.data, content: [] }
              : row.data,
        }
        // A summary references the first message it kept, which the fork copied under a new ID.
        const keepID = row.type === "compaction" ? row.data.metadata?.keepID : undefined
        if (!Schema.is(SessionMessage.ID)(keepID)) return copy
        const kept = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(and(eq(SessionMessageTable.session_id, event.data.parentID), eq(SessionMessageTable.id, keepID)))
          .get()
          .pipe(Effect.orDie)
        if (!kept) return copy
        return {
          ...copy,
          data: { ...row.data, metadata: { ...row.data.metadata, keepID: forkedID(kept.seq) } },
        }
      }),
    )
    yield* db.insert(SessionMessageTable).values(values).run().pipe(Effect.orDie)

    const assistantRows = rows.filter((row) => row.type === "assistant")
    if (assistantRows.length > 0) {
      const idMap = new Map(assistantRows.map((row) => [row.id, forkedID(row.seq)]))
      const storedParts = yield* db
        .select()
        .from(SessionPartTable)
        .where(
          and(
            eq(SessionPartTable.session_id, event.data.parentID),
            inArray(
              SessionPartTable.message_id,
              assistantRows.map((row) => row.id),
            ),
          ),
        )
        .orderBy(asc(SessionPartTable.message_id), asc(SessionPartTable.ordinal))
        .all()
        .pipe(Effect.orDie)
      const splitParentIDs = new Set(storedParts.map((part) => part.message_id))
      const partValues: Array<typeof SessionPartTable.$inferInsert> = storedParts.map((part) => ({
        message_id: idMap.get(part.message_id)!,
        session_id: event.data.sessionID,
        ordinal: part.ordinal,
        type: part.type,
        call_id: part.call_id,
        change_seq: event.durable.seq,
        time_created: part.time_created,
        time_updated: part.time_updated,
        data: part.data,
      }))
      for (const row of assistantRows) {
        if (splitParentIDs.has(row.id) || !SessionHistory.hasInlineContent(row.data)) continue
        const decoded = SessionHistory.decodeMessageRowSync(row)
        if (decoded.type !== "assistant") continue
        decoded.content.forEach((part, ordinal) => {
          partValues.push({
            message_id: idMap.get(row.id)!,
            session_id: event.data.sessionID,
            ordinal,
            type: part.type,
            call_id: part.type === "tool" ? part.id : null,
            change_seq: event.durable.seq,
            time_created: row.time_created,
            time_updated: row.time_updated,
            data: SessionHistory.encodePart(part),
          })
        })
      }
      for (let index = 0; index < partValues.length; index += ForkBatchSize) {
        yield* db
          .insert(SessionPartTable)
          .values(partValues.slice(index, index + ForkBatchSize))
          .run()
          .pipe(Effect.orDie)
      }
    }

    cursor = rows.at(-1)!.seq
  }
  if (copiedSeq !== undefined) yield* Bus.reserveSequence(db, event.data.sessionID, copiedSeq)
  if (event.data.instructions)
    yield* InstructionState.initialize(db, event.data.sessionID, event.durable.seq, event.data.instructions)
})

function run(db: DatabaseService, event: MessageEvent) {
  return Effect.gen(function* () {
    const changeSeq = event.durable.seq
    // Part keys at or past `from` that a rewrite of the message's parts no longer holds. `inline` counts the parts a
    // legacy row held in `data.content`, which the feed sent as part keys too.
    const deleteParts = Effect.fnUntraced(function* (messageID: SessionMessage.ID, from: number, inline = 0) {
      const deleted = yield* db
        .delete(SessionPartTable)
        .where(eq(SessionPartTable.message_id, messageID))
        .returning({ ordinal: SessionPartTable.ordinal })
        .all()
        .pipe(Effect.orDie)
      const ordinals = new Set(deleted.map((row) => row.ordinal))
      for (let ordinal = 0; ordinal < inline; ordinal++) ordinals.add(ordinal)
      yield* SessionChanges.tombstone(
        db,
        event.data.sessionID,
        changeSeq,
        [...ordinals].flatMap((ordinal) =>
          ordinal >= from ? [{ kind: "part" as const, rowID: messageID, ordinal }] : [],
        ),
      )
    })
    const splitLegacyAssistantRow = Effect.fnUntraced(function* (row: typeof SessionMessageTable.$inferSelect) {
      const message = SessionHistory.decodeMessageRowSync(row)
      if (message.type !== "assistant") return undefined
      if (!SessionHistory.hasInlineContent(row.data)) return message
      const partRows = message.content.map((part, ordinal) => ({
        message_id: message.id,
        session_id: row.session_id,
        ordinal,
        type: part.type,
        call_id: part.type === "tool" ? part.id : null,
        change_seq: changeSeq,
        time_created: row.time_created,
        time_updated: event.created,
        data: SessionHistory.encodePart(part),
      }))
      yield* deleteParts(message.id, partRows.length)
      for (let index = 0; index < partRows.length; index += ForkBatchSize) {
        yield* db
          .insert(SessionPartTable)
          .values(partRows.slice(index, index + ForkBatchSize))
          .run()
          .pipe(Effect.orDie)
      }
      const envelope: SessionMessage.Assistant = { ...message, content: [] }
      const { id: _, type: __, ...data } = encodeMessage(envelope)
      yield* db
        .update(SessionMessageTable)
        .set({ data, change_seq: changeSeq })
        .where(and(eq(SessionMessageTable.id, message.id), eq(SessionMessageTable.session_id, row.session_id)))
        .run()
        .pipe(Effect.orDie)
      return envelope
    })
    const ensureAssistantPartsSplit = Effect.fnUntraced(function* (messageID: SessionMessage.ID) {
      const row = yield* db
        .select({
          id: SessionMessageTable.id,
          inlineCount: sql<number>`json_array_length(${SessionMessageTable.data}, '$.content')`,
        })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.id, messageID),
            eq(SessionMessageTable.session_id, event.data.sessionID),
            eq(SessionMessageTable.type, "assistant"),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return false
      if (row.inlineCount > 0) {
        const full = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        if (full) yield* splitLegacyAssistantRow(full)
      }
      return true
    })
    const updateMessage = (message: SessionMessage.Info) => {
      const encoded = encodeMessage(
        message.type === "assistant" && message.content.length > 0 ? { ...message, content: [] } : message,
      )
      const { id: _, type: __, ...data } = encoded
      return db
        .update(SessionMessageTable)
        .set({
          ...(event.type === SessionEvent.Step.Started.type
            ? { time_created: DateTime.toEpochMillis(message.time.created) }
            : {}),
          data,
          change_seq: changeSeq,
        })
        .where(and(eq(SessionMessageTable.id, message.id), eq(SessionMessageTable.session_id, event.data.sessionID)))
        .run()
        .pipe(Effect.orDie)
    }
    const appendMessage = (message: SessionMessage.Info) => insertMessage(db, event, message)
    const adapter: SessionMessageUpdater.Adapter = {
      getAgent() {
        return db
          .select({ agent: SessionTable.agent })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => row?.agent ?? undefined),
          )
      },
      getModel() {
        return db
          .select({ model: SessionTable.model })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => (row?.model ? Schema.decodeUnknownSync(Model.Ref)(row.model) : undefined)),
          )
      },
      getLocation() {
        return db
          .select({
            directory: SessionTable.directory,
            workspaceID: SessionTable.workspace_id,
            projectID: SessionTable.project_id,
            subpath: SessionTable.path,
          })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) =>
              row
                ? {
                    location: {
                      directory: AbsolutePath.make(row.directory),
                      workspaceID: row.workspaceID ?? undefined,
                    },
                    projectID: row.projectID,
                    subpath: row.subpath === null ? undefined : RelativePath.make(row.subpath),
                  }
                : undefined,
            ),
          )
      },
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer step supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = yield* splitLegacyAssistantRow(row)
          return message && !message.time.completed ? message : undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          return yield* splitLegacyAssistantRow(row)
        })
      },
      appendAssistantPart(messageID, part) {
        return Effect.gen(function* () {
          if (!(yield* ensureAssistantPartsSplit(messageID))) return
          const next = yield* db
            .select({ ordinal: sql<number>`coalesce(max(${SessionPartTable.ordinal}) + 1, 0)` })
            .from(SessionPartTable)
            .where(eq(SessionPartTable.message_id, messageID))
            .get()
            .pipe(Effect.orDie)
          yield* db
            .insert(SessionPartTable)
            .values({
              message_id: messageID,
              session_id: event.data.sessionID,
              ordinal: next?.ordinal ?? 0,
              type: part.type,
              call_id: part.type === "tool" ? part.id : null,
              change_seq: changeSeq,
              time_created: event.created,
              time_updated: event.created,
              data: SessionHistory.encodePart(part),
            })
            .run()
            .pipe(Effect.orDie)
        })
      },
      updateAssistantPart(messageID, match, recipe) {
        return Effect.gen(function* () {
          if (!(yield* ensureAssistantPartsSplit(messageID))) return
          const row = yield* db
            .select()
            .from(SessionPartTable)
            .where(
              and(
                eq(SessionPartTable.message_id, messageID),
                eq(SessionPartTable.session_id, event.data.sessionID),
                eq(SessionPartTable.type, match.type),
                match.callID !== undefined ? eq(SessionPartTable.call_id, match.callID) : undefined,
                match.incompleteReasoning
                  ? sql`json_extract(${SessionPartTable.data}, '$.time.completed') is null`
                  : undefined,
              ),
            )
            .orderBy(desc(SessionPartTable.ordinal))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return

          const current = SessionHistory.decodePartRowSync(row) as Extract<
            SessionMessage.AssistantContent,
            { readonly type: typeof match.type }
          >
          const updated = produce(current, recipe)
          if (updated === current) return
          yield* db
            .update(SessionPartTable)
            .set({ data: SessionHistory.encodePart(updated), time_updated: event.created, change_seq: changeSeq })
            .where(and(eq(SessionPartTable.message_id, messageID), eq(SessionPartTable.ordinal, row.ordinal)))
            .run()
            .pipe(Effect.orDie)
        })
      },
      replaceAssistantParts(messageID, parts) {
        return Effect.gen(function* () {
          const messageRow = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!messageRow) return
          let inline = 0
          if (SessionHistory.hasInlineContent(messageRow.data)) {
            const message = SessionHistory.decodeMessageRowSync(messageRow)
            if (message.type === "assistant") {
              inline = message.content.length
              const { id: _, type: __, ...data } = encodeMessage({ ...message, content: [] })
              yield* db
                .update(SessionMessageTable)
                .set({ data, change_seq: changeSeq })
                .where(eq(SessionMessageTable.id, messageID))
                .run()
                .pipe(Effect.orDie)
            }
          }
          yield* deleteParts(messageID, parts.length, inline)
          const partRows = parts.map((part, ordinal) => ({
            message_id: messageID,
            session_id: event.data.sessionID,
            ordinal,
            type: part.type,
            call_id: part.type === "tool" ? part.id : null,
            change_seq: changeSeq,
            time_created: event.created,
            time_updated: event.created,
            data: SessionHistory.encodePart(part),
          }))
          for (let index = 0; index < partRows.length; index += ForkBatchSize) {
            yield* db
              .insert(SessionPartTable)
              .values(partRows.slice(index, index + ForkBatchSize))
              .run()
              .pipe(Effect.orDie)
          }
        })
      },
      getShell(shellID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "shell"),
                sql`json_extract(${SessionMessageTable.data}, '$.shellID') = ${shellID}`,
              ),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = SessionHistory.decodeMessageRowSync(row)
          return message.type === "shell" ? message : undefined
        })
      },
      getCompaction() {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "compaction"),
                sql`json_extract(${SessionMessageTable.data}, '$.status') = 'running'`,
              ),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = SessionHistory.decodeMessageRowSync(row)
          return message.type === "compaction" ? message : undefined
        })
      },
      updateAssistant: updateMessage,
      updateShell: updateMessage,
      updateCompaction: updateMessage,
      appendMessage,
    }
    yield* SessionMessageUpdater.update(adapter, event)
  })
}

function insertMessage(db: DatabaseService, event: SessionEvent.DurableEvent, message: SessionMessage.Info) {
  return Effect.gen(function* () {
    const encoded = encodeMessage(
      message.type === "assistant" && message.content.length > 0 ? { ...message, content: [] } : message,
    )
    const { id: _, type, ...data } = encoded
    const timeCreated = DateTime.toEpochMillis(message.time.created)
    yield* db
      .insert(SessionMessageTable)
      .values({
        id: message.id,
        session_id: event.data.sessionID,
        type,
        seq: event.durable.seq,
        change_seq: event.durable.seq,
        time_created: timeCreated,
        data,
      })
      .run()
      .pipe(Effect.orDie)
    if (message.type === "assistant" && message.content.length > 0) {
      const partRows = message.content.map((part, ordinal) => ({
        message_id: message.id,
        session_id: event.data.sessionID,
        ordinal,
        type: part.type,
        call_id: part.type === "tool" ? part.id : null,
        change_seq: event.durable.seq,
        time_created: timeCreated,
        time_updated: event.created,
        data: SessionHistory.encodePart(part),
      }))
      for (let index = 0; index < partRows.length; index += ForkBatchSize) {
        yield* db
          .insert(SessionPartTable)
          .values(partRows.slice(index, index + ForkBatchSize))
          .run()
          .pipe(Effect.orDie)
      }
    }
  })
}

function projectIdle(
  db: DatabaseService,
  event:
    | typeof SessionEvent.Execution.Succeeded.Type
    | typeof SessionEvent.Execution.Failed.Type
    | typeof SessionEvent.Execution.Interrupted.Type,
) {
  return Effect.gen(function* () {
    yield* run(db, event)
    if (event.type === SessionEvent.Execution.Interrupted.type && event.data.reason === "shutdown") return
    const time = event.created
    const outcome =
      event.type === SessionEvent.Execution.Succeeded.type
        ? "succeeded"
        : event.type === SessionEvent.Execution.Failed.type
          ? "failed"
          : "interrupted"
    yield* db
      .update(SessionTable)
      .set({
        // Unread uses a strict timestamp comparison, so every terminal must advance even within one millisecond.
        time_idle: sql`max(${time}, coalesce(${SessionTable.time_idle} + 1, ${time}))`,
        idle_outcome: outcome,
        time_updated: sql`${SessionTable.time_updated}`,
        change_seq: event.durable.seq,
      })
      .where(eq(SessionTable.id, event.data.sessionID))
      .run()
      .pipe(Effect.orDie)
  })
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const db = (yield* Database.Service).db
    yield* bus.project(SessionEvent.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values({
            id: event.data.sessionID,
            project_id: event.data.projectID,
            workspace_id: event.data.location.workspaceID ?? null,
            parent_id: event.data.parentID,
            slug: event.data.slug,
            directory: event.data.location.directory,
            path: event.data.subpath,
            title: event.data.title,
            agent: event.data.agent,
            model: event.data.model,
            metadata: event.data.metadata,
            permission: event.data.permissions,
            version: event.data.version,
            time_created: event.created,
            time_updated: event.created,
            change_seq: event.durable.seq,
          })
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
      }),
    )
    yield* bus.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* db
          .update(SessionTable)
          .set({
            change_seq: event.durable.seq,
            directory: event.data.location.directory,
            path: event.data.subpath,
            ...(event.data.projectID ? { project_id: event.data.projectID } : {}),
            workspace_id: event.data.location.workspaceID ?? null,
            time_updated: event.created,
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    // Sessions whose ownership came from the directory's previous resolution
    // follow its new identity. Location, transcript, instructions, and recency
    // are untouched: the session did not move, its directory got identified.
    yield* bus.project(Worktree.Event.Resolved, (event) =>
      Effect.gen(function* () {
        const candidates = [
          ...new Set(
            [event.data.previous, Project.ID.global, ...(event.data.adopted ?? [])].filter(
              (id) => id !== event.data.projectID,
            ),
          ),
        ]
        if (candidates.length === 0) return
        const rows = yield* db
          .select({
            id: SessionTable.id,
            directory: SessionTable.directory,
            projectID: SessionTable.project_id,
            canonical: ProjectTable.worktree,
          })
          .from(SessionTable)
          .innerJoin(ProjectTable, eq(SessionTable.project_id, ProjectTable.id))
          .where(
            and(
              inArray(SessionTable.project_id, candidates),
              isNull(SessionTable.workspace_id),
              or(
                event.data.adopted?.length ? inArray(SessionTable.project_id, event.data.adopted) : undefined,
                and(
                  gte(SessionTable.directory, event.data.directory),
                  lte(SessionTable.directory, AbsolutePath.make(event.data.directory + "\uffff")),
                ),
              ),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        yield* Effect.forEach(
          rows,
          (row) => {
            const directory = event.data.adopted?.includes(row.projectID)
              ? row.canonical
              : AbsolutePath.make(path.resolve(row.directory))
            if (!FSUtil.contains(event.data.directory, directory)) return Effect.void
            return Effect.gen(function* () {
              // Another aggregate's event changes this session's row, so it takes the session's next change number.
              const changeSeq = yield* SessionChanges.reserve(db, row.id)
              yield* db
                .update(SessionTable)
                .set({
                  change_seq: changeSeq,
                  project_id: event.data.projectID,
                  path: RelativePath.make(path.relative(event.data.directory, directory).replaceAll("\\", "/")),
                  // Self-assignment suppresses the column's $onUpdate: adoption is not activity.
                  time_updated: sql`${SessionTable.time_updated}`,
                })
                .where(eq(SessionTable.id, row.id))
                .run()
                .pipe(Effect.orDie)
            })
          },
          { discard: true },
        )
      }),
    )
    yield* bus.project(SessionEvent.Deleted, (event) =>
      db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie),
    )
    yield* bus.project(SessionEvent.AgentSelected, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* db
          .update(SessionTable)
          .set({ agent: event.data.agent, time_updated: event.created, change_seq: event.durable.seq })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* bus.project(SessionEvent.ModelSelected, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* db
          .update(SessionTable)
          .set({ model: event.data.model, time_updated: event.created, change_seq: event.durable.seq })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* bus.project(SessionEvent.Renamed, (event) =>
      db
        .update(SessionTable)
        .set({ title: event.data.title, time_updated: event.created, change_seq: event.durable.seq })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* bus.project(SessionEvent.MetadataUpdated, (event) =>
      db
        .update(SessionTable)
        .set({ metadata: event.data.metadata, time_updated: event.created, change_seq: event.durable.seq })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* bus.project(SessionEvent.Permissions, (event) =>
      db
        .update(SessionTable)
        .set({ permission: event.data.permissions, time_updated: event.created, change_seq: event.durable.seq })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* bus.project(SessionEvent.Viewed, (event) => {
      const idle = event.data.idle
      return db
        .update(SessionTable)
        .set({
          change_seq: event.durable.seq,
          // Monotone watermark: a duplicate or stale view never regresses, and a terminal event
          // committing after the viewer's observation keeps the newer idle transition unread.
          time_viewed: sql`max(${idle}, coalesce(${SessionTable.time_viewed}, ${idle}))`,
          time_updated: sql`${SessionTable.time_updated}`,
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie)
    })
    yield* bus.project(SessionEvent.Archived, (event) =>
      db
        .update(SessionTable)
        .set({ time_archived: event.created, time_updated: event.created, change_seq: event.durable.seq })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* bus.project(SessionEvent.Unarchived, (event) =>
      db
        .update(SessionTable)
        .set({ time_archived: null, time_updated: event.created, change_seq: event.durable.seq })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* bus.project(SessionEvent.MessageContentUpdated, (event) => run(db, event))
    yield* bus.project(SessionEvent.UsageRecorded, (event) =>
      applyUsage(db, event.data.sessionID, event.durable.seq, event.data),
    )
    yield* bus.project(SessionEvent.Forked, (event) => projectFork(db, event))
    yield* bus.project(SessionEvent.InboxDelivered, (event) =>
      Effect.gen(function* () {
        const input = yield* SessionInbox.projectDelivered(db, {
          id: event.data.inboxID,
          sessionID: event.data.sessionID,
        })
        yield* SessionChanges.tombstone(db, event.data.sessionID, event.durable.seq, [
          { kind: "inbox", rowID: event.data.inboxID },
        ])
        if (input.type === "compaction" || input.type === "move") return
        yield* insertMessage(
          db,
          event,
          input.type === "user"
            ? {
                id: input.id,
                type: "user",
                metadata: input.payload.metadata,
                text: input.payload.text,
                files: input.payload.files,
                agents: input.payload.agents,
                skills: input.payload.skills,
                time: { created: DateTime.makeUnsafe(event.created) },
              }
            : {
                id: input.id,
                type: "synthetic",
                text: input.payload.text,
                description: input.payload.description,
                metadata: input.payload.metadata,
                time: { created: DateTime.makeUnsafe(event.created) },
              },
        )
      }),
    )
    yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
      Effect.gen(function* () {
        yield* SessionInbox.projectAdmitted(db, {
          enqueuedSeq: event.durable.seq,
          id: event.data.inboxID,
          sessionID: event.data.sessionID,
          item: event.data.item,
          timeCreated: event.created,
        })
        yield* db
          .update(SessionTable)
          .set({ time_updated: event.created, change_seq: event.durable.seq })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* bus.project(SessionEvent.InboxCancelled, (event) =>
      Effect.gen(function* () {
        yield* SessionInbox.projectCancelled(db, {
          id: event.data.inboxID,
          sessionID: event.data.sessionID,
        })
        yield* SessionChanges.tombstone(db, event.data.sessionID, event.durable.seq, [
          { kind: "inbox", rowID: event.data.inboxID },
        ])
      }),
    )
    yield* bus.project(SessionEvent.InboxDeliveryChanged, (event) =>
      SessionInbox.projectDeliveryChanged(db, {
        id: event.data.inboxID,
        sessionID: event.data.sessionID,
        delivery: event.data.delivery,
        changeSeq: event.durable.seq,
      }),
    )
    yield* bus.project(SessionEvent.Execution.Succeeded, (event) => projectIdle(db, event))
    yield* bus.project(SessionEvent.Execution.Failed, (event) => projectIdle(db, event))
    yield* bus.project(SessionEvent.Execution.Interrupted, (event) => projectIdle(db, event))
    yield* bus.project(SessionEvent.InstructionsUpdated, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* InstructionState.apply(db, event.data.sessionID, event.durable.seq, event.data.delta)
      }),
    )
    yield* bus.project(SessionEvent.Synthetic, (event) => run(db, event))
    yield* bus.project(SessionEvent.Skill.Activated, (event) => run(db, event))
    yield* bus.project(SessionEvent.Shell.Started, (event) => run(db, event))
    yield* bus.project(SessionEvent.Shell.Ended, (event) => run(db, event))
    yield* bus.project(SessionEvent.Step.Started, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* touch(db, event)
      }),
    )
    yield* bus.project(SessionEvent.Step.Streamed, (event) => run(db, event))
    yield* bus.project(SessionEvent.Step.Ended, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* applyUsage(db, event.data.sessionID, event.durable.seq, event.data, event.created)
      }),
    )
    yield* bus.project(SessionEvent.Step.Failed, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        if (event.data.cost !== undefined && event.data.tokens !== undefined)
          yield* applyUsage(
            db,
            event.data.sessionID,
            event.durable.seq,
            { cost: event.data.cost, tokens: event.data.tokens },
            event.created,
          )
        else yield* touch(db, event)
      }),
    )
    yield* bus.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* bus.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* bus.project(SessionEvent.Tool.Input.Started, (event) => run(db, event))
    yield* bus.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* bus.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* bus.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* bus.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* bus.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* bus.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    yield* bus.project(SessionEvent.RetryScheduled, (event) => run(db, event))
    yield* bus.project(SessionEvent.Compaction.Started, (event) => run(db, event))
    yield* bus.project(SessionEvent.Compaction.Ended, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* InstructionState.advanceEpoch(db, event.data.sessionID, event.durable.seq)
      }),
    )
    yield* bus.project(SessionEvent.Compaction.Failed, (event) => run(db, event))
    yield* bus.project(SessionEvent.RevertEvent.Staged, (event) =>
      Effect.gen(function* () {
        const revert = event.data.revert
        yield* db
          .update(SessionTable)
          .set({
            change_seq: event.durable.seq,
            revert,
            time_updated: event.created,
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* bus.project(SessionEvent.RevertEvent.Cleared, (event) =>
      db
        .update(SessionTable)
        .set({ revert: null, time_updated: event.created, change_seq: event.durable.seq })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* bus.project(SessionEvent.RevertEvent.Committed, (event) =>
      Effect.gen(function* () {
        const boundary = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.id, event.data.to)),
          )
          .get()
          .pipe(Effect.orDie)
        if (!boundary) return yield* Effect.die(new Error(`Revert boundary message not found: ${event.data.to}`))
        const messages = yield* db
          .delete(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), gte(SessionMessageTable.seq, boundary.seq)),
          )
          .returning({ id: SessionMessageTable.id })
          .all()
          .pipe(Effect.orDie)
        const inbox = yield* db
          .delete(SessionInboxTable)
          .where(
            and(
              eq(SessionInboxTable.session_id, event.data.sessionID),
              gte(SessionInboxTable.enqueued_seq, boundary.seq),
            ),
          )
          .returning({ id: SessionInboxTable.id })
          .all()
          .pipe(Effect.orDie)
        yield* SessionChanges.tombstone(db, event.data.sessionID, event.durable.seq, [
          ...messages.map((row) => ({ kind: "message" as const, rowID: row.id })),
          ...inbox.map((row) => ({ kind: "inbox" as const, rowID: row.id })),
        ])
        yield* db
          .update(SessionTable)
          .set({ revert: null, time_updated: event.created, change_seq: event.durable.seq })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* InstructionState.rewind(db, event.data.sessionID, boundary.seq)
      }),
    )
    yield* bus.subscribe([SessionEvent.Step.Ended, SessionEvent.Step.Failed, SessionEvent.UsageRecorded]).pipe(
      Stream.runForEach((event) => {
        if (
          event.type === SessionEvent.Step.Failed.type &&
          (event.data.cost === undefined || event.data.tokens === undefined)
        )
          return Effect.void
        return publishSessionUsage(db, bus, event.data.sessionID)
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
)

export const node = makeGlobalNode({ name: "session-projector", layer, deps: [Bus.node, Database.node] })
