import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { prefersReducedMotion, Spring } from "@opencode/ui/motion"

// Panels in flight, across the app. Native views, which can't fade with the DOM, stay hidden while any panel moves.
const [flights, setFlights] = createSignal(0)

export const panelsMoving = () => flights() > 0

// Layout changes at once; only the panel moves, by a few pixels toward its edge, and fades. Both run as Web Animations
// on transform and opacity, so the compositor plays them through main-thread work like mounting the panel.
const shift = springEasing(0.24)

const fade = { duration: 180, easing: "cubic-bezier(0.44, 0.75, 0.63, 1.03)" }

const faded = 0.15

// Shortcuts toggle panels many times a day, so a toggle from the keyboard skips the motion.
let keyboard = false

if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => (keyboard = true), true)
  window.addEventListener("pointerdown", () => (keyboard = false), true)
}

/**
 * Fades an edge panel in and out while it shifts `offset` pixels toward its edge (negative for the inline-start edge;
 * mirrored in RTL). `present` stays true until a close settles, so the panel can stay visible while it leaves.
 * `whenSettled` defers work until the motion lands; `sync` shows a state at once, for changes the user makes by hand.
 */
export function createPanelMotion(input: {
  open: Accessor<boolean>
  element: Accessor<HTMLElement | undefined>
  offset: number
  /** A change shows the new state without motion, e.g. switching to another session's layout. */
  identity?: Accessor<unknown>
}) {
  const [present, setPresent] = createSignal(input.open())
  let animations: Animation[] = []
  let landed: (() => void)[] = []
  // A state `sync` asked to show at once, for when the change hasn't reached this motion yet, e.g. inside a batch.
  let snapTo: boolean | undefined

  const stop = () => {
    if (animations.length > 0) setFlights((count) => count - 1)
    animations.forEach((animation) => animation.cancel())
    animations = []
  }

  const settle = () => {
    if (!input.open()) setPresent(false)
    stop()
    const queued = landed
    landed = []
    queued.forEach((run) => run())
  }

  createEffect(
    on(
      () => [input.open(), input.identity?.()] as const,
      ([open, identity], previous) => {
        // Work queued for the previous direction no longer applies.
        landed = []
        const now = snapTo === open || keyboard || prefersReducedMotion()
        snapTo = undefined

        if (open) setPresent(true)

        const element = input.element()

        if (previous === undefined || previous[1] !== identity || now || !element?.animate) return settle()

        const x = input.offset * (element.matches(":dir(rtl)") ? -1 : 1)
        const away = { transform: `translateX(${x}px)`, opacity: `${faded}` }
        const rest = { transform: "none", opacity: "1" }
        const target = open ? rest : away
        // A reversal mid-flight starts from where the panel is now.
        const start = animations.length > 0 ? getComputedStyle(element) : open ? away : rest

        stop()
        setFlights((count) => count + 1)
        animations = [
          element.animate({ transform: [start.transform, target.transform] }, { ...shift, fill: "both" }),
          element.animate({ opacity: [start.opacity, target.opacity] }, { ...fade, fill: "both" }),
        ]
        const current = animations
        void Promise.all(current.map((animation) => animation.finished)).then(
          () => current === animations && settle(),
          () => undefined,
        )
      },
    ),
  )

  onCleanup(stop)

  return {
    present,
    sync: (open: boolean) => {
      if (animations.length > 0 && input.open() === open) return settle()
      snapTo = open
    },
    whenSettled: (run: () => void) => {
      if (animations.length > 0) return void landed.push(run)
      run()
    },
  }
}

/**
 * A critically damped spring of SwiftUI-style `duration` seconds, sampled per frame into a CSS `linear()` easing. It
 * ends once within 0.5% of rest, a twentieth of a pixel on these shifts.
 */
function springEasing(duration: number) {
  const spring = Spring.fromDuration(0, { duration, bounce: 0 }).set(1)
  const points = [0]

  while (points.at(-1)! < 0.995) points.push(Math.round(spring.step(1 / 60) * 1000) / 1000)
  points[points.length - 1] = 1

  return { duration: ((points.length - 1) * 1000) / 60, easing: `linear(${points.join(", ")})` }
}

/**
 * Keeps focus out of a closing panel without `inert`, which would restyle every element in it: focus inside moves to
 * `target` when the close starts and whenever it enters during the flight. A settled panel is skipped, so nothing in
 * it can take focus.
 */
export function guardClosingFocus(input: {
  root: Accessor<HTMLElement | undefined>
  closing: Accessor<boolean>
  target: () => HTMLElement | undefined
}) {
  const evict = () => {
    const root = input.root()

    if (!input.closing() || !root?.contains(document.activeElement)) return
    const target = input.target()

    if (target) return target.focus({ preventScroll: true })

    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }

  createEffect(on(input.closing, evict, { defer: true }))
  createEffect(() => {
    const root = input.root()

    if (!root) return
    root.addEventListener("focusin", evict)
    onCleanup(() => root.removeEventListener("focusin", evict))
  })
}
