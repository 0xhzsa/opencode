import { Schema } from "effect"
import { motionTuning, type MotionKnob } from "@opencode/ui/motion-tuning"
import type { KnobValue, TourStop } from "./manifest"

/** What a stop's setup drives: the app's own router, palette, dialogs and Settings. */
export type TourApp = {
  navigate: (path: string) => void
  /** The first healthy server's route segment and session path. */
  serverSegment: () => string | undefined
  sessionPath: (sessionID: string) => string | undefined
  /** Opens a Settings page; false when there's no such page. */
  settings: (tab: string) => boolean
  palette: () => void
  dialogOpen: () => boolean
  closeDialog: () => void
}

/** Runs a stop's setup in order: one place to go, its knobs, then the palette. Spotlights follow on their own. */
export async function arrive(stop: TourStop, app: TourApp, knobs: KnobScope, signal: AbortSignal) {
  if (app.dialogOpen()) app.closeDialog()

  go(stop, app)

  if (stop.knobs) await knobs.apply(stop.knobs, signal)

  if (stop.palette === undefined) return

  const text = stop.palette

  await until(() => (app.dialogOpen() ? undefined : true), signal)

  // A page still loading may not have registered the palette's command yet, so opening retries until a dialog shows.
  let opened = 0
  const field = () => document.querySelector<HTMLInputElement>('[role="dialog"] input')

  await until(() => {
    if (field()) return true

    if (app.dialogOpen() || performance.now() - opened < 750) return
    opened = performance.now()
    app.palette()
  }, signal)

  // Typed a letter at a time, so a recording shows the list filtering as it would by hand. Each letter finds the field
  // again, in case the palette re-rendered it.
  for (const end of text.split("").keys()) {
    await delay(45, signal)

    const input = await until(field, signal)
    input.value = text.slice(0, end + 1)
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text[end] }))
  }
}

function go(stop: TourStop, app: TourApp) {
  if (stop.route !== undefined) {
    const segment = stop.route.includes(":server") ? app.serverSegment() : ""

    if (segment === undefined) throw new Error("No healthy server for :server")

    return app.navigate(stop.route.replaceAll(":server", segment))
  }

  if (stop.session !== undefined) {
    const path = app.sessionPath(stop.session)

    if (!path) throw new Error("No healthy server to open the session on")

    return app.navigate(path)
  }

  if (stop.story !== undefined) return app.navigate(`/components?story=${encodeURIComponent(stop.story)}`)

  if (stop.settings !== undefined && !app.settings(stop.settings)) throw new Error(`No Settings page ${stop.settings}`)
}

/**
 * The knobs a stop changed, so leaving it puts them back. Knobs register when their surface's module loads, so a value
 * for one that hasn't registered yet waits for it.
 */
export function knobScope() {
  const original = new Map<string, { knob: MotionKnob; value: MotionKnob["value"] }>()

  return {
    async apply(values: { readonly [id: string]: KnobValue }, signal: AbortSignal) {
      const knobs = await registered(values, signal)

      knobs.forEach((knob) => {
        if (!original.has(knob.id)) original.set(knob.id, { knob, value: knob.value })
        setKnob(knob, values[knob.id])
      })
    },
    /** Whether the knobs hold these values. */
    async holds(values: { readonly [id: string]: KnobValue }, signal: AbortSignal) {
      const knobs = await registered(values, signal)

      return knobs.every((knob) => JSON.stringify(knob.value) === JSON.stringify(values[knob.id]))
    },
    restore() {
      original.forEach((entry) => motionTuning.set(entry.knob, entry.value))
      original.clear()
    },
  }
}

export type KnobScope = ReturnType<typeof knobScope>

function registered(values: { readonly [id: string]: KnobValue }, signal: AbortSignal) {
  return Promise.all(
    Object.keys(values).map((id) => until(() => motionTuning.list().find((knob) => knob.id === id), signal)),
  )
}

function setKnob(knob: MotionKnob, value: KnobValue | undefined) {
  if (knob.kind === "choice" && isText(value) && knob.options.includes(value)) return motionTuning.set(knob, value)

  if ((knob.kind === "toggle" || knob.kind === "mode") && isBoolean(value)) return motionTuning.set(knob, value)

  if (knob.kind === "number" && isNumber(value)) return motionTuning.set(knob, value)

  if (knob.kind === "spring" && isSpring(value)) return motionTuning.set(knob, value)

  throw new Error(`${knob.id} can't be ${JSON.stringify(value)}`)
}

/** Resolves with the first value `read` gives within 15 seconds (a session can be slow to load), checking each frame. */
export function until<T>(read: () => T | null | undefined, signal: AbortSignal, timeout = 15_000) {
  return new Promise<T>((resolve, reject) => {
    const started = performance.now()

    const check = () => {
      if (signal.aborted) return reject(signal.reason)

      const value = read()

      if (value !== null && value !== undefined) return resolve(value)

      if (performance.now() - started > timeout) return reject(new Error("Timed out waiting for the app"))
      requestAnimationFrame(check)
    }

    check()
  })
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)

    const timer = setTimeout(resolve, ms)

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

const isText = Schema.is(Schema.String)

const isBoolean = Schema.is(Schema.Boolean)

const isNumber = Schema.is(Schema.Finite)

const isSpring = Schema.is(Schema.Struct({ duration: Schema.Finite, bounce: Schema.Finite }))
