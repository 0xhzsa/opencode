import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, describe, expect } from "bun:test"
import { Clock, Duration, Effect } from "effect"
import { eq } from "drizzle-orm"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Job } from "@opencode/core/job"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionExpiry } from "@opencode/core/session/expiry"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Global } from "@opencode/util/global"
import { FSUtil } from "@opencode/util/fs-util"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const globalDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "opencode-session-expiry-")))
afterAll(() => fs.rmSync(globalDirectory, { recursive: true, force: true }))

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      SessionExecution.node,
      Job.node,
      Global.node,
      FSUtil.node,
    ]),
    [
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      Global.node.replace(Global.layerWith({ config: globalDirectory, home: path.join(globalDirectory, "home") })),
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const day = Duration.toMillis(Duration.days(1))

const age = Effect.fn(function* (sessionID: Session.ID, days: number) {
  const { db } = yield* Database.Service
  const now = yield* Clock.currentTimeMillis
  yield* db
    .update(SessionTable)
    .set({ time_updated: now - days * day })
    .where(eq(SessionTable.id, sessionID))
    .run()
})

const exists = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    return yield* session.get(sessionID).pipe(
      Effect.as(true),
      Effect.catchTag("Session.NotFoundError", () => Effect.succeed(false)),
    )
  })

describe("SessionExpiry", () => {
  it.effect("deletes top-level sessions and their children past their max age", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const old = yield* session.create({ location })
      const child = yield* session.create({ parentID: old.id })
      const recent = yield* session.create({ location })
      yield* age(old.id, 40)
      // A child's own age never matters; it lives and dies with its top-level Session.
      yield* age(child.id, 1)
      yield* age(recent.id, 10)

      expect(yield* SessionExpiry.expire(Duration.days(30))).toBe(1)
      expect(yield* exists(old.id)).toBe(false)
      expect(yield* exists(child.id)).toBe(false)
      expect(yield* exists(recent.id)).toBe(true)
    }),
  )

  it.effect("keeps suspended sessions for restart recovery", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const store = yield* SessionStore.Service
      const suspended = yield* session.create({ location })
      yield* store.claim(suspended.id)
      yield* age(suspended.id, 40)

      expect(yield* SessionExpiry.expire(Duration.days(30))).toBe(0)
      expect(yield* exists(suspended.id)).toBe(true)
    }),
  )

  it.effect("reads storage.sessions from global config and keeps sessions when unset", () =>
    Effect.gen(function* () {
      const file = path.join(globalDirectory, "opencode.json")
      fs.rmSync(file, { force: true })
      expect(yield* SessionExpiry.configured()).toBeUndefined()

      fs.writeFileSync(file, JSON.stringify({ storage: { sessions: "30 days" } }))
      expect(Duration.toMillis((yield* SessionExpiry.configured())!)).toBe(Duration.toMillis(Duration.days(30)))
      fs.rmSync(file)
    }),
  )

  it.effect("decodes storage.sessions from JSONC and ignores invalid values", () =>
    Effect.sync(() => {
      expect(Duration.toMillis(SessionExpiry.decodeMaxAge('{ "storage": { "sessions": "7 days", }, }')!)).toBe(7 * day)
      expect(SessionExpiry.decodeMaxAge('{ "storage": {} }')).toBeUndefined()
      expect(SessionExpiry.decodeMaxAge('{ "storage": { "sessions": "soon" } }')).toBeUndefined()
      expect(SessionExpiry.decodeMaxAge("{ broken")).toBeUndefined()
    }),
  )
})
