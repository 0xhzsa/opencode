export * as GenUISession from "./session.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { InstructionEntry } from "@opencode/schema/instruction-entry"
import type { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { GenUI } from "./genui.js"

export const KEY = InstructionEntry.Key.make("genui")

const enter = `The user is viewing this session in the OpenCode app. For the occasional answer that is clearly better seen or clicked than read, such as a dashboard, a chart of real data or a form, ${GenUI.RENDER_TOOL} draws interactive UI while you write it; load the genui skill first. Answer everything else in text as usual. When the in-app browser is connected, its tools are in your tool list and the browser skill explains them.`

const leave = `${GenUI.RENDER_TOOL} is no longer available in this session, because the user is not in the OpenCode app or turned generated UI off. Answer in text.`

/**
 * Tells the agent it may use the render tool only while the user can see generated UI: the app marks its prompts with
 * `metadata.genui = true` while the setting is on, so the latest prompt decides. Sessions the app never prompted, such
 * as subagents, never see the tool.
 */
export const register = Effect.fn("GenUISession.register")(function* (ctx: {
  readonly session: Pick<Context["session"], "hook" | "instructions">
}) {
  const state = Effect.fnUntraced(function* (sessionID: Session.ID) {
    const entries = yield* ctx.session.instructions.entry
      .list({ sessionID })
      .pipe(Effect.orElseSucceed(() => [] as const))
    const entry = entries.find((item) => item.key === KEY)
    return entry === undefined ? undefined : entry.value === enter
  })

  yield* ctx.session.hook(
    "prompt",
    Effect.fnUntraced(function* (event) {
      const previous = yield* state(event.sessionID)
      const next = event.metadata?.genui === true
      if ((previous ?? false) === next) return
      yield* ctx.session.instructions.entry
        .put({
          sessionID: event.sessionID,
          key: KEY,
          value: next ? enter : leave,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to update the GenUI instruction entry", { sessionID: event.sessionID, cause }),
          ),
        )
    }),
  )

  // The tool list is the head of the cached prompt, so it must not flip with each prompt's source (app, phone,
  // scheduled prompt) or reset on restart. Once a session has been offered generated UI it keeps the tool, and the
  // instruction entry says whether it can be used. Summary and generate requests reuse the session's cached prompt,
  // so they get the same tool list.
  const tools = Effect.fnUntraced(function* (event: SessionContext) {
    if ((yield* state(event.sessionID)) === undefined) delete event.tools[GenUI.RENDER_TOOL]
  })
  yield* ctx.session.hook("context", tools)
  yield* ctx.session.hook("compaction", tools)
  yield* ctx.session.hook("generate", tools)
})
