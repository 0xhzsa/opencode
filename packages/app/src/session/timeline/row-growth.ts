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

const grid = (value: number) => Math.round(value * 64) / 64

type Growth = { value: number; target: number; enter?: () => void }

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
  let spring: Spring | undefined
  let fresh = false
  let held: Spring | undefined
  let closing = false
  let quiet = 0
  let stop: (() => void) | undefined

  const advance = (dt: number) => {
    if (!spring || !growths.size) {
      spring = undefined
      return
    }
    const before = grid(spring.value)
    const beforeRaw = spring.value
    const nextValue = spring.step(dt)
    const target = spring.target
    // A growth bent toward a nearer target keeps its speed and would pass it, then come back: it lands there instead.
    const done = spring.resting || (target - before) * (target - nextValue) <= 0
    let budget = done ? Infinity : Math.max(0, nextValue - beforeRaw)

    growths.forEach((growth, key) => {
      const prevShown = grid(growth.value)
      const rem = growth.target - growth.value
      const take = rem <= 0 ? 0 : Math.min(rem, budget)
      if (take > 0) budget -= take
      const nextRowValue = rem <= 0 ? growth.value : growth.value + take
      const rowDone =
        done || (growth.target - prevShown) * (growth.target - nextRowValue) <= 0 || growth.target - nextRowValue <= 1e-4
      growth.value = nextRowValue
      const shown = rowDone ? growth.target : grid(growth.value)
      if (!rowDone && take <= 0) return

      const enter = growth.enter
      if (enter) {
        growth.enter = undefined
        enter()
      }
      const wrapper = input.resize(key, shown)

      if (wrapper === false) {
        const unconsumed = Math.max(0, growth.target - growth.value)
        growths.delete(key)
        if (unconsumed > 0) spring?.set(spring.target - unconsumed)
      } else if (rowDone) {
        if (growth.value < growth.target && spring) spring.value += growth.target - growth.value
        growths.delete(key)
      }

      if (held && wrapper !== false && input.below(key))
        held.value = Math.max(0, held.value - Math.max(0, shown - prevShown))
    })

    if (done || !growths.size) spring = undefined
  }

  const settle = () => {
    let pending = 0
    growths.forEach((growth) => (pending += Math.max(0, growth.target - grid(growth.value))))
    input.settle({ pending, held: held ? Math.max(0, grid(held.value)) : 0 })
  }

  const step = (dt: number) => {
    batch(() => advance(dt))
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
    if (!fresh) return
    fresh = false
    input.measure()
    batch(() => advance(1 / 60))
    settle()
  }

  return {
    growing: () => growths.size > 0,
    target: (key: string) => growths.get(key)?.target,
    grow(key: string, from: number, to: number, enter?: () => void) {
      const wasGrowing = growths.size > 0
      const running = growths.get(key)
      if (running) {
        const delta = to - running.target
        running.target = to
        if (enter && !running.enter) running.enter = enter
        spring?.set(spring.target + delta)
        return
      }
      const delta = to - from
      if (delta <= 0) {
        enter?.()
        input.resize(key, to)
        return
      }
      growths.set(key, { value: from, target: to, enter })
      if (!spring) spring = Spring.fromDuration(0, growthSpring())
      spring.set(spring.target + delta)
      stop ??= frameLoop.addMeasured(input.measure, step)

      if (!wasGrowing && !fresh) {
        fresh = true
        queueMicrotask(kick)
      }
    },
    hold(size: number) {
      held ??= Spring.fromDuration(0, growthSpring())
      held.value += size
      held.set(0)
      stop ??= frameLoop.addMeasured(input.measure, step)
    },
    land(key: string, size: number) {
      const running = growths.get(key)
      if (running) {
        const rem = Math.max(0, running.target - running.value)
        growths.delete(key)
        if (spring) spring.set(spring.target - rem)
        if (!growths.size) spring = undefined
      }
      input.resize(key, size)
    },
    finish() {
      fresh = false
      stop?.()
      stop = undefined
      spring = undefined
      held = undefined
      closing = false
      batch(() =>
        growths.forEach((growth, key) => {
          growth.enter?.()
          input.resize(key, growth.target)
        }),
      )
      growths.clear()
    },
  }
}
