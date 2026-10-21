export * as SessionExpiry from "./expiry.js"

import path from "path"
import { and, asc, isNull, lt } from "drizzle-orm"
import { parse, type ParseError } from "jsonc-parser"
import { Clock, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import { Job } from "../job.js"
import { Session } from "../session.js"
import { SessionExecution } from "./execution.js"
import { SessionTable } from "./sql.js"

const SWEEP_INTERVAL = Duration.hours(1)

const decodeSessions = Schema.decodeUnknownOption(Schema.DurationFromString)

/** Projects `storage.sessions` from one global config file, like the CLI updater's `update` policy. */
export function decodeMaxAge(text: string) {
  const errors: ParseError[] = []
  const input: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || typeof input !== "object" || input === null || !("storage" in input)) return
  const storage = input.storage
  if (typeof storage !== "object" || storage === null || !("sessions" in storage)) return
  return Option.getOrUndefined(decodeSessions(storage.sessions))
}

/**
 * Reads `storage.sessions` from the global config directory only. Project config is never read,
 * so a project cannot delete another project's Sessions. Later files win, as with `update`.
 */
export const configured = Effect.fn("SessionExpiry.configured")(function* () {
  const global = yield* Global.Service
  const fs = yield* FSUtil.Service
  const values = yield* Effect.forEach(["config.json", "opencode.json", "opencode.jsonc"], (name) =>
    fs.readFileStringSafe(path.join(global.config, name)).pipe(
      Effect.map((text) => (text === undefined ? undefined : decodeMaxAge(text))),
      Effect.orElseSucceed(() => undefined),
    ),
  )
  return values.findLast((value) => value !== undefined)
})

/**
 * Deletes top-level Sessions, with their children, whose last activity is older than `maxAge`.
 * Returns the deleted Session count.
 */
export const expire = Effect.fn("SessionExpiry.expire")(function* (maxAge: Duration.Duration) {
  const { db } = yield* Database.Service
  const execution = yield* SessionExecution.Service
  const jobs = yield* Job.Service
  const sessions = yield* Session.Service
  const cutoff = (yield* Clock.currentTimeMillis) - Duration.toMillis(maxAge)
  // Suspended Sessions belong to restart recovery, which resumes or terminalizes them.
  const expired = yield* db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(
      and(isNull(SessionTable.parent_id), isNull(SessionTable.time_suspended), lt(SessionTable.time_updated, cutoff)),
    )
    .orderBy(asc(SessionTable.time_updated))
    .all()
    .pipe(Effect.orDie)
  if (expired.length === 0) return 0
  // Waiting on a question, a long tool call, or a background job emits no activity.
  const occupied = new Set([
    ...(yield* execution.active),
    ...(yield* jobs.runningBackground).flatMap((recovery) =>
      recovery.kind === "shell" ? [recovery.sessionID] : [recovery.childSessionID, recovery.parentSessionID],
    ),
  ])
  const removable = expired.filter((row) => !occupied.has(row.id))
  yield* Effect.forEach(
    removable,
    (row) => sessions.remove(row.id).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void)),
    { discard: true },
  )
  return removable.length
})

/** Applies the global `storage.sessions` config. Unset keeps every Session. */
export const sweep = Effect.fn("SessionExpiry.sweep")(function* () {
  const maxAge = yield* configured()
  if (maxAge === undefined) return
  const millis = Duration.toMillis(maxAge)
  if (!Number.isFinite(millis) || millis <= 0) {
    yield* Effect.logWarning("storage.sessions must be a finite positive duration")
    return
  }
  const count = yield* expire(maxAge)
  if (count === 0) return
  yield* Effect.logInfo("deleted expired sessions", { count, maxAge: Duration.format(maxAge) })
})

export const node = makeGlobalNode({
  name: "session-expiry-sweep",
  layer: Layer.effectDiscard(
    sweep().pipe(
      Effect.ignoreCause({ log: "Error", message: "Session expiry sweep failed" }),
      Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
      Effect.forkScoped,
    ),
  ),
  deps: [Database.node, FSUtil.node, Global.node, Job.node, Session.node, SessionExecution.node],
})
