import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { prefersReducedMotion, Spring } from "@opencode/ui/motion"

// Panels opening, across the app. Native views, which can't fade with the DOM, stay hidden until the panel lands.
const [flights, setFlights] = createSignal(0)

export const panelsMoving = () => flights() > 0

// Layout changes at once; an opening panel shifts in a few pixels from its edge and fades up. Both run as Web
// Animations on transform and opacity, so the compositor plays them through main-thread work like mounting the panel.
const shift = springEasing(0.24)

const fade = { duration: 180, easing: "cubic-bezier(0.44, 0.75, 0.63, 1.03)" }

// Shortcuts toggle panels many times a day, so a toggle from the keyboard skips the motion.
let keyboard = false

if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => (keyboard = true), true)
  window.addEventListener("pointerdown", () => (keyboard = false), true)
}

/**
 * Opens an edge panel by shifting it `offset` pixels in from its edge (negative for the inline-start edge; mirrored in
 * RTL) while it fades up from 0.15. Closing is instant and cancels an opening in flight. `whenSettled` defers work
 * until the opening lands.
 */
export function createPanelMotion(input: {
  open: Accessor<boolean>
  element: Accessor<HTMLElement | undefined>
  offset: number
  /** A change shows the new state without motion, e.g. switching to another session's layout. */
  identity?: Accessor<unknown>
}) {
  let animations: Animation[] = []
  let landed: (() => void)[] = []

  const settle = () => {
    if (animations.length > 0) setFlights((count) => count - 1)
    animations.forEach((animation) => animation.cancel())
    animations = []
    const queued = landed
    landed = []
    queued.forEach((run) => run())
  }

  createEffect(
    on(
      () => [input.open(), input.identity?.()] as const,
      ([open, identity], previous) => {
        // Work queued for an opening that a close interrupted no longer applies.
        if (!open) landed = []
        settle()
        const element = input.element()

        const instant = !previous || previous[1] !== identity || keyboard || prefersReducedMotion()

        if (!open || instant || !element?.animate) return

        const x = input.offset * (element.matches(":dir(rtl)") ? -1 : 1)
        setFlights((count) => count + 1)
        animations = [
          element.animate({ transform: [`translateX(${x}px)`, "none"] }, shift),
          element.animate({ opacity: [0.15, 1] }, fade),
        ]
        const current = animations
        void Promise.all(current.map((animation) => animation.finished)).then(
          () => current === animations && settle(),
          () => undefined,
        )
      },
    ),
  )

  onCleanup(settle)

  return {
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
 * Moves focus out of a panel when it closes, to `target`, without `inert`, which would restyle every element in it.
 * The closed panel is skipped by content-visibility, so nothing in it can take focus afterwards.
 */
export function releaseClosedFocus(input: {
  root: Accessor<HTMLElement | undefined>
  open: Accessor<boolean>
  target: () => HTMLElement | undefined
}) {
  createEffect(
    on(
      input.open,
      (open) => {
        if (open || !input.root()?.contains(document.activeElement)) return
        const target = input.target()

        if (target) return target.focus({ preventScroll: true })

        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      },
      { defer: true },
    ),
  )
}
