import { afterEach, expect, it } from "bun:test"
import { batch, createRoot, createSignal } from "solid-js"
import { createPanelMotion, panelsMoving, releaseClosedFocus } from "../src/shell/panel-motion"

type Played = {
  keyframes: PropertyIndexedKeyframes
  options: KeyframeAnimationOptions
  cancelled: boolean
  finish: () => void
}

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  delete document.documentElement.dataset.motion
})

// happy-dom has no Web Animations, so the panel element records what it was asked to play.
function setup(initial: boolean) {
  const [open, setOpen] = createSignal(initial)
  const [identity, setIdentity] = createSignal("a")
  const played: Played[] = []
  const element = document.createElement("div")
  Object.defineProperty(element, "animate", {
    value: (keyframes: PropertyIndexedKeyframes, options: KeyframeAnimationOptions) => {
      const finished = Promise.withResolvers<void>()
      const animation = { keyframes, options, cancelled: false, finish: () => finished.resolve() }
      played.push(animation)

      return {
        finished: finished.promise,
        cancel: () => {
          animation.cancelled = true
          finished.reject(new Error("cancelled"))
        },
      }
    },
  })

  const motion = createRoot((dispose) => {
    cleanups.push(dispose)

    return createPanelMotion({ open, element: () => element, offset: -10, identity })
  })

  return { played, setOpen, setIdentity, motion }
}

const land = async (played: Played[]) => {
  played.filter((animation) => !animation.cancelled).forEach((animation) => animation.finish())
  await Promise.resolve()
  await Promise.resolve()
}

it("opens with a 10px shift on a 240 ms critically damped spring and a 180 ms fade from 0.15", async () => {
  const panel = setup(false)
  panel.setOpen(true)

  const [shift, fade] = panel.played
  expect(shift.keyframes.transform).toEqual(["translateX(-10px)", "none"])
  // The easing samples x(t) = 1 - (1 + ωt)e^(-ωt) with ω = 2π / 0.24 s, one point per 60 Hz frame.
  const omega = (2 * Math.PI) / 0.24
  const points = String(shift.options.easing).slice("linear(".length, -1).split(", ").map(Number)
  points.slice(1, -1).forEach((point, index) => {
    const t = (index + 1) / 60
    expect(point).toBeCloseTo(1 - (1 + omega * t) * Math.exp(-omega * t), 3)
  })
  expect(points.at(-1)).toBe(1)
  expect(shift.options.duration).toBeCloseTo(((points.length - 1) * 1000) / 60)
  expect(fade.keyframes.opacity).toEqual([0.15, 1])
  expect(fade.options).toMatchObject({ duration: 180, easing: "cubic-bezier(0.44, 0.75, 0.63, 1.03)" })
  expect(panelsMoving()).toBe(true)
  await land(panel.played)
  expect(panelsMoving()).toBe(false)
  expect(panel.played.every((animation) => animation.cancelled)).toBe(true)
})

it("closes instantly, cancelling an opening in flight and the work queued for it", () => {
  const panel = setup(false)
  const ran: string[] = []
  panel.setOpen(true)
  panel.motion.whenSettled(() => ran.push("opened"))
  panel.setOpen(false)

  expect(panel.played).toHaveLength(2)
  expect(panel.played.every((animation) => animation.cancelled)).toBe(true)
  expect(panelsMoving()).toBe(false)
  expect(ran).toEqual([])
  panel.motion.whenSettled(() => ran.push("at rest"))
  expect(ran).toEqual(["at rest"])
})

it("runs settled work once an opening lands", async () => {
  const panel = setup(false)
  const ran: string[] = []
  panel.setOpen(true)
  panel.motion.whenSettled(() => ran.push("opened"))

  expect(ran).toEqual([])
  await land(panel.played)
  expect(ran).toEqual(["opened"])
})

it("opens from the keyboard without motion", () => {
  const panel = setup(false)
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }))
  panel.setOpen(true)
  window.dispatchEvent(new PointerEvent("pointerdown"))

  expect(panel.played).toEqual([])
  expect(panelsMoving()).toBe(false)
})

it("opens without motion under reduced motion", () => {
  document.documentElement.dataset.motion = "reduce"
  const panel = setup(false)
  panel.setOpen(true)

  expect(panel.played).toEqual([])
})

it("shows another layout's open panel without motion", () => {
  const panel = setup(false)
  batch(() => {
    panel.setOpen(true)
    panel.setIdentity("b")
  })

  expect(panel.played).toEqual([])
})

it("moves focus out of a panel when it closes", () => {
  const root = document.createElement("div")
  const inner = document.createElement("button")
  const toggle = document.createElement("button")
  root.append(inner)
  document.body.append(root, toggle)
  const [open, setOpen] = createSignal(true)
  cleanups.push(
    createRoot((dispose) => {
      releaseClosedFocus({ root: () => root, open, target: () => toggle })

      return dispose
    }),
    () => {
      root.remove()
      toggle.remove()
    },
  )

  inner.focus()
  setOpen(false)
  expect(document.activeElement).toBe(toggle)

  setOpen(true)
  inner.focus()
  expect(document.activeElement).toBe(inner)
})
