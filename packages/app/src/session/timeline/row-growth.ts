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

export const workingHandoffDuration = 0.34

const ease = (t: number) => t * t * (3 - 2 * t)
const easeOut = (t: number) => 1 - (1 - t) * (1 - t)

// Like the iOS WorkingHandoffPose: Working blurs and shrinks out as the reply's copy button sharpens in.
export function workingHandoffPose(handoff: number, handsOffToCopy = true, reduceMotion = false) {
  const m = Math.min(1, Math.max(0, handoff))
  if (m <= 0)
    return {
      indicatorOpacity: 1,
      indicatorBlur: 0,
      indicatorScale: 1,
      copyOpacity: 0,
      copyBlur: 6,
      copyScale: 0.6,
    }
  if (reduceMotion)
    return {
      indicatorOpacity: 1 - m,
      indicatorBlur: 0,
      indicatorScale: 1,
      copyOpacity: handsOffToCopy ? m : 0,
      copyBlur: 0,
      copyScale: 1,
    }
  if (!handsOffToCopy) {
    const out = ease(m)
    return {
      indicatorOpacity: 1 - out,
      indicatorBlur: 4 * m,
      indicatorScale: 1 - 0.04 * out,
      copyOpacity: 0,
      copyBlur: 6,
      copyScale: 0.6,
    }
  }
  const out = Math.min(1, Math.max(0, m / 0.7))
  const into = Math.min(1, Math.max(0, (m - 0.25) / 0.75))
  const easedOut = ease(out)
  const easedInto = easeOut(into)
  return {
    indicatorOpacity: 1 - easedOut,
    indicatorBlur: 6 * out,
    indicatorScale: 1 - 0.5 * easedOut,
    copyOpacity: easedInto,
    copyBlur: 6 * (1 - into),
    copyScale: 0.6 + 0.4 * easedInto,
  }
}

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

  const totalRemaining = () => {
    let sum = 0
    growths.forEach((growth) => (sum += Math.abs(growth.target - growth.value)))
    return sum
  }

  const advance = (dt: number) => {
    if (!spring || !growths.size) {
      spring = undefined
      return
    }
    const before = grid(spring.value)
    const beforeRaw = spring.value
    const nextValue = spring.step(dt)
    const target = spring.target
    const remBefore = totalRemaining()
    // A growth bent toward a nearer target keeps its speed and would pass it, then come back: it lands there instead.
    const done = spring.resting || (target - before) * (target - nextValue) <= 0 || remBefore <= 1e-4
    const stepSize = Math.max(0, nextValue - beforeRaw)
    const fraction = done ? 1 : Math.min(1, stepSize / remBefore)

    growths.forEach((growth, key) => {
      const prevShown = grid(growth.value)
      const diff = growth.target - growth.value
      const nextRowValue = done ? growth.target : growth.value + diff * fraction
      const rowDone =
        done ||
        (growth.target - prevShown) * (growth.target - nextRowValue) <= 0 ||
        Math.abs(growth.target - nextRowValue) <= 1e-4
      growth.value = rowDone ? growth.target : nextRowValue
      const shown = rowDone ? growth.target : grid(growth.value)

      const enter = growth.enter
      if (enter) {
        growth.enter = undefined
        enter()
      }
      if (!rowDone && (Math.abs(diff) <= 0 || stepSize <= 0)) return
      const wrapper = input.resize(key, shown)

      if (wrapper === false) {
        const unconsumed = Math.abs(growth.target - growth.value)
        growths.delete(key)
        if (unconsumed > 0) spring?.set(Math.max(spring.value, spring.target - unconsumed))
      } else if (rowDone) {
        growths.delete(key)
      }

      if (held && wrapper !== false && input.below(key))
        held.value = Math.max(0, held.value - Math.max(0, shown - prevShown))
    })

    if (done || !growths.size) spring = undefined
  }

  const settle = () => {
    let net = 0
    growths.forEach((growth) => (net += growth.target - grid(growth.value)))
    input.settle({ pending: Math.max(0, grid(net)), held: held ? Math.max(0, grid(held.value)) : 0 })
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
        if (running.target > running.value && to <= running.value) {
          this.land(key, to)
          return
        }
        const oldRem = Math.abs(running.target - running.value)
        running.target = to
        const newRem = Math.abs(to - running.value)
        if (enter && !running.enter) running.enter = enter
        spring?.set(spring.target + newRem - oldRem)
        return
      }
      const rem = Math.abs(to - from)
      if (rem <= 1e-4) {
        enter?.()
        input.resize(key, to)
        return
      }
      growths.set(key, { value: from, target: to, enter })
      if (!spring) spring = Spring.fromDuration(0, growthSpring())
      spring.set(spring.target + rem)
      stop ??= frameLoop.addMeasured(input.measure, step)

      if (!wasGrowing && !fresh) {
        fresh = true
        queueMicrotask(kick)
      }
    },
    absorb(key: string, removed: number, base: number, to: number, enter?: () => void) {
      const running = growths.get(key)
      if (!running) {
        const from = base + removed
        if (Math.abs(to - from) <= 1e-4) {
          queueMicrotask(() => {
            enter?.()
            this.land(key, to)
          })
          return
        }
        this.grow(key, from, to, enter)
        return
      }
      const oldRem = Math.abs(running.target - running.value)
      running.value += removed
      running.target = to
      const newRem = Math.abs(running.target - running.value)
      if (enter && !running.enter) running.enter = enter
      if (newRem <= 1e-4) {
        queueMicrotask(() => this.land(key, to))
        return
      }
      spring?.set(Math.max(spring.value, spring.target + newRem - oldRem))
    },
    drop(key: string) {
      const running = growths.get(key)
      if (!running) return
      const rem = Math.abs(running.target - running.value)
      growths.delete(key)
      if (spring) spring.set(Math.max(spring.value, spring.target - rem))
      if (!growths.size) spring = undefined
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
        const rem = Math.abs(running.target - running.value)
        growths.delete(key)
        if (spring) spring.set(Math.max(spring.value, spring.target - rem))
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
