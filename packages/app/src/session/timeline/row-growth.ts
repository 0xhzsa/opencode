import { batch } from "solid-js"
import { frameLoop, Spring } from "@opencode/ui/motion"
import { motionTuning } from "@opencode/ui/motion-tuning"

// Like the iOS transcript: while the timeline follows its end, a row's displayed height springs to its measured height.
export const growthSpring = motionTuning.spring("timeline.growth", {
  label: "Row growth",
  group: "Timeline",
  presets: {
    snappy: { duration: 0.32, bounce: 0 },
    smooth: { duration: 0.42, bounce: 0 },
    calm: { duration: 0.55, bounce: 0 },
  },
})

const softEdge = 28

const grid = (value: number) => Math.round(value * 64) / 64

type Growth = { spring: Spring; start: number }

/**
 * Rows whose displayed height eases toward their measured height, and a gap left by a row near the end that closes on
 * the same spring. Each frame `measure` reads layout before any writes, `resize` commits a displayed height and returns
 * the row's clipping wrapper (false once the row has left the list), `below` tells whether a row is below the gap, and
 * `settle` runs once after the sizes with how far the rows still have to grow and how much of the gap is still open.
 */
export function createRowGrowth(input: {
  measure: () => void
  resize: (key: string, size: number) => HTMLElement | false | undefined
  below: (key: string) => boolean
  settle: (state: { pending: number; held: number }) => void
}) {
  const growths = new Map<string, Growth>()
  const fresh = new Set<string>()
  let held: Spring | undefined
  let closing = false
  let quiet = 0
  let stop: (() => void) | undefined

  const advance = (key: string, growth: Growth, dt: number) => {
    const before = grid(growth.spring.value)
    const value = growth.spring.step(dt)
    const target = growth.spring.target
    // A growth bent toward a nearer target keeps its speed and would pass it, then come back: it lands there instead.
    const resting = growth.spring.resting || (target - before) * (target - value) <= 0
    const shown = resting ? growth.spring.target : grid(value)
    const wrapper = input.resize(key, shown)

    if (wrapper === false || resting) growths.delete(key)

    if (wrapper)
      paintEdge(
        wrapper,
        resting ? 0 : Math.min(softEdge, Math.abs(growth.spring.target - value), Math.abs(value - growth.start)),
      )

    if (held && wrapper !== false && input.below(key))
      held.value = Math.max(0, held.value - Math.max(0, shown - before))
  }

  const settle = () => {
    let pending = 0
    growths.forEach((growth) => (pending += growth.spring.target - grid(growth.spring.value)))
    input.settle({ pending, held: held ? Math.max(0, grid(held.value)) : 0 })
  }

  const step = (dt: number) => {
    batch(() => growths.forEach((growth, key) => advance(key, growth, dt)))
    // Wait briefly before closing what growth left of the gap so pauses between streamed chunks do not start and stop it.
    quiet = growths.size ? 0 : quiet + dt

    if (held && (closing || quiet >= 0.12)) {
      closing = true
      held.step(dt)
    }

    if (held?.resting) {
      held = undefined
      closing = false
    }

    settle()

    if (growths.size > 0 || held) return true
    stop = undefined

    return false
  }

  const kick = () => {
    const keys = [...fresh]
    fresh.clear()
    input.measure()
    batch(() =>
      keys.forEach((key) => {
        const growth = growths.get(key)

        if (growth) advance(key, growth, 1 / 60)
      }),
    )
    settle()
  }

  return {
    growing: () => growths.size > 0,
    target: (key: string) => growths.get(key)?.spring.target,
    grow(key: string, from: number, to: number) {
      const running = growths.get(key)
      const growth = running ?? { spring: Spring.fromDuration(from, growthSpring()), start: from }
      growth.spring.set(to)
      growths.set(key, growth)
      stop ??= frameLoop.addMeasured(input.measure, step)

      if (running) return

      if (!fresh.size) queueMicrotask(kick)
      fresh.add(key)
    },
    hold(size: number) {
      held ??= Spring.fromDuration(0, growthSpring())
      held.value += size
      held.set(0)
      stop ??= frameLoop.addMeasured(input.measure, step)
    },
    land(key: string, size: number) {
      growths.delete(key)
      const wrapper = input.resize(key, size)

      if (wrapper) paintEdge(wrapper, 0)
    },
    finish() {
      fresh.clear()
      stop?.()
      stop = undefined
      held = undefined
      closing = false
      batch(() =>
        growths.forEach((growth, key) => {
          const wrapper = input.resize(key, growth.spring.target)

          if (wrapper) paintEdge(wrapper, 0)
        }),
      )
      growths.clear()
    },
  }
}

function paintEdge(wrapper: HTMLElement, fade: number) {
  if (fade < 0.5) return wrapper.style.removeProperty("mask-image")
  wrapper.style.setProperty(
    "mask-image",
    `linear-gradient(to bottom, #000 calc(100% - ${fade.toFixed(2)}px), transparent)`,
  )
}
