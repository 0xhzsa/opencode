import { afterEach, expect, it } from "bun:test"
import { batch, createRoot, createSignal } from "solid-js"
import { createPanelMotion, guardClosingFocus, panelsMoving } from "../src/shell/panel-motion"

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

it("opens with a short shift on a spring and a fade from 0.15, present until a close lands", async () => {
  const panel = setup(false)
  panel.setOpen(true)

  expect(panel.motion.present()).toBe(true)
  const [shift, fade] = panel.played
  expect(shift.keyframes.transform).toEqual(["translateX(-10px)", "none"])
  expect(shift.options.easing).toStartWith("linear(0, ")
  expect(shift.options.duration).toBeGreaterThan(240)
  expect(shift.options.duration).toBeLessThan(320)
  expect(fade.keyframes.opacity).toEqual(["0.15", "1"])
  expect(fade.options).toMatchObject({ duration: 180, easing: "cubic-bezier(0.44, 0.75, 0.63, 1.03)" })
  expect(panelsMoving()).toBe(true)
  await land(panel.played)
  expect(panelsMoving()).toBe(false)

  panel.setOpen(false)
  expect(panel.played.at(-1)!.keyframes.opacity).toEqual(["1", "0.15"])
  expect(panel.motion.present()).toBe(true)
  await land(panel.played)
  expect(panel.motion.present()).toBe(false)
  expect(panel.played.every((animation) => animation.cancelled)).toBe(true)
})

it("toggles from the keyboard without motion", () => {
  const panel = setup(true)
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }))
  panel.setOpen(false)
  window.dispatchEvent(new PointerEvent("pointerdown"))

  expect(panel.played).toEqual([])
  expect(panel.motion.present()).toBe(false)
  expect(panelsMoving()).toBe(false)
})

it("snaps under reduced motion", () => {
  document.documentElement.dataset.motion = "reduce"
  const panel = setup(true)
  panel.setOpen(false)

  expect(panel.played).toEqual([])
  expect(panel.motion.present()).toBe(false)
})

it("turns around mid-flight, dropping the first direction's animations and settled work", async () => {
  const panel = setup(false)
  const ran: string[] = []
  panel.setOpen(true)
  panel.motion.whenSettled(() => ran.push("opened"))
  panel.setOpen(false)
  panel.motion.whenSettled(() => ran.push("closed"))

  expect(panel.played.slice(0, 2).every((animation) => animation.cancelled)).toBe(true)
  await land(panel.played)
  expect(ran).toEqual(["closed"])
  expect(panel.motion.present()).toBe(false)
  panel.motion.whenSettled(() => ran.push("at rest"))
  expect(ran).toEqual(["closed", "at rest"])
})

it("shows another layout's state without motion", () => {
  const panel = setup(true)
  batch(() => {
    panel.setOpen(false)
    panel.setIdentity("b")
  })

  expect(panel.played).toEqual([])
  expect(panel.motion.present()).toBe(false)
})

it("shows a state at once when synced, also from inside a batch", () => {
  const panel = setup(true)
  batch(() => {
    panel.setOpen(false)
    panel.motion.sync(false)
  })

  expect(panel.played).toEqual([])
  expect(panel.motion.present()).toBe(false)

  panel.setOpen(true)
  panel.motion.sync(true)
  expect(panel.played.every((animation) => animation.cancelled)).toBe(true)
  expect(panelsMoving()).toBe(false)
})

it("moves focus out of a closing panel when the close starts and when it re-enters mid-flight", () => {
  const root = document.createElement("div")
  const inner = document.createElement("button")
  const toggle = document.createElement("button")
  root.append(inner)
  document.body.append(root, toggle)
  const [closing, setClosing] = createSignal(false)
  cleanups.push(
    createRoot((dispose) => {
      guardClosingFocus({ root: () => root, closing, target: () => toggle })

      return dispose
    }),
    () => {
      root.remove()
      toggle.remove()
    },
  )

  inner.focus()
  setClosing(true)
  expect(document.activeElement).toBe(toggle)

  inner.focus()
  expect(document.activeElement).toBe(toggle)

  setClosing(false)
  inner.focus()
  expect(document.activeElement).toBe(inner)
})
