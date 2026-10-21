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

const softEdge = 28

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

type Coupled = { key: string; base: number; extra: number }

type Growth = {
  value: number
  target: number
  opaque: number
  maskPx: number
  freshRow: boolean
  entering: boolean
  enterSpan: number
  enterProgress: number
  enter?: () => void
  coupled?: Coupled
}

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
  foldRoom?: () => number
  movesWorking?: (key: string) => boolean
  settle: (state: { pending: number; held: number }) => void
}) {
  const growths = new Map<string, Growth>()
  let spring: Spring | undefined
  let fresh = false
  let lastTake = 0
  let held: Spring | undefined
  let closing = false
  let quiet = 0
  let stop: (() => void) | undefined

  const advance = (dt: number) => {
    if (!spring || !growths.size) {
      spring = undefined
      lastTake = 0
      return
    }
    spring.tune(growthSpring())
    const before = grid(spring.value)
    const beforeRaw = spring.value
    const nextValue = spring.step(dt)
    const target = spring.target
    // A growth bent toward a nearer target keeps its speed and would pass it, then come back: it lands there instead.
    const done = spring.resting || (target - before) * (target - nextValue) <= 0
    const rawBudget = done ? Infinity : Math.max(0, nextValue - beforeRaw)
    const scale = Math.max(1, motionTuning.timeScale())
    let stepped = false
    let consumed = 0

    growths.forEach((growth, key) => {
      const prevShown = grid(growth.value)
      const diff = growth.target - growth.value
      const rem = Math.abs(diff)
      if (rem <= 1e-4 && growth.entering) {
        const wrapper = input.resize(key, growth.target)
        if (wrapper) {
          paintEdge(wrapper, growth, 0)
          paintArrival(wrapper, growth, growth.target)
        }
        if (!growth.entering || !wrapper) growths.delete(key)
        return
      }
      if (stepped) return
      const slowWorking = input.movesWorking?.(key) ?? false
      if (growth.freshRow) {
        growth.freshRow = false
        lastTake = 0
      }
      const startStep = 1.875 / scale
      const cap = slowWorking ? 7.5 / scale : rem <= 120 || lastTake < 7.5 / scale ? 11.5 / scale : 22 / scale
      let maxTake = Math.max(startStep, Math.min(cap, lastTake > 0 ? 3.2 * lastTake : startStep))
      const room = input.foldRoom?.() ?? 0
      if (!growth.coupled && room > 1 / 64 && room < maxTake) {
        maxTake = grid(room)
        growth.freshRow = true
      }
      const take = rem <= 0 ? 0 : Math.min(rem, rawBudget, done && rem <= maxTake ? rem : maxTake)
      stepped = true
      consumed = take
      lastTake = take
      const nextRowValue = rem <= 0 ? growth.value : growth.value + Math.sign(diff) * take
      const rowDone =
        (done && rem <= maxTake) ||
        (growth.target - prevShown) * (growth.target - nextRowValue) <= 0 ||
        Math.abs(growth.target - nextRowValue) <= 1e-4
      growth.value = rowDone ? growth.target : nextRowValue
      const shown = rowDone ? growth.target : grid(growth.value)
      if (!rowDone && take <= 0 && !growth.entering) return

      const enter = growth.enter
      if (enter) {
        growth.enter = undefined
        enter()
      }
      const wrapper = input.resize(key, shown)
      if (growth.coupled) {
        const coupled = growth.coupled
        if (rowDone || wrapper === false) {
          const cWrapper = input.resize(coupled.key, coupled.base)
          if (cWrapper) clearWrapper(cWrapper)
        } else {
          const ratio = Math.max(0, Math.min(1, 1 - shown / Math.max(1, growth.target)))
          input.resize(coupled.key, grid(coupled.base + coupled.extra * ratio))
        }
      }

      if (wrapper === false) {
        const unconsumed = Math.abs(growth.target - growth.value)
        growths.delete(key)
        if (unconsumed > 0) spring?.set(Math.max(spring.value, spring.target - unconsumed))
      } else {
        if (wrapper) {
          if (rowDone || growth.target <= shown) {
            paintEdge(wrapper, growth, 0)
          } else {
            const wantFade = Math.min(softEdge, Math.max(0, growth.target - shown) * 1.5)
            growth.opaque = Math.max(growth.opaque, shown - wantFade)
            paintEdge(wrapper, growth, Math.max(0, Math.min(shown, shown - growth.opaque)))
          }
          if (growth.entering) paintArrival(wrapper, growth, shown)
        }
        if (rowDone) {
          if (rem > take && spring) spring.value += rem - take
          if (!growth.entering || !wrapper) growths.delete(key)
        }
      }

      if (held && wrapper !== false && input.below(key))
        held.value = Math.max(0, held.value - Math.max(0, shown - prevShown))
    })

    if (spring && Number.isFinite(rawBudget) && consumed < rawBudget) {
      spring.value = Math.min(spring.target, beforeRaw + consumed)
    }

    if (!growths.size) {
      spring = undefined
      lastTake = 0
    }
  }

  const settle = () => {
    let net = 0
    growths.forEach((growth) => {
      net += growth.target - grid(growth.value)
      if (growth.coupled) {
        const ratio = Math.max(0, Math.min(1, 1 - grid(growth.value) / Math.max(1, growth.target)))
        net -= grid(growth.coupled.extra * ratio)
      }
    })
    input.settle({ pending: Math.max(0, grid(net)), held: held ? Math.max(0, grid(held.value)) : 0 })
  }

  const step = (dt: number) => {
    const stepDt = fresh ? 1 / 60 : Math.min(dt, 1 / 30)
    fresh = false
    batch(() => advance(stepDt))
    // Wait briefly before closing what growth left of the gap so pauses between streamed chunks do not start and stop it.
    quiet = growths.size ? 0 : quiet + stepDt

    if (held && (closing || quiet >= 0.12)) {
      closing = true
      held.tune(growthSpring())
      held.step(stepDt)
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

  return {
    growing: () => growths.size > 0,
    entering: (key: string) => growths.get(key)?.entering === true,
    target: (key: string) => {
      const direct = growths.get(key)?.target
      if (direct !== undefined) return direct
      for (const growth of growths.values()) {
        if (growth.coupled?.key === key) return growth.coupled.base
      }
      return undefined
    },
    grow(key: string, from: number, to: number, enter?: (() => void) | boolean, coupled?: Coupled) {
      const entering = typeof enter === "boolean" ? enter : !!enter
      const onEnter = typeof enter === "function" ? enter : undefined
      const wasGrowing = growths.size > 0
      const running = growths.get(key)
      if (running) {
        if (running.target > running.value && to <= running.value) {
          this.land(key, to)
          return
        }
        const oldRem = Math.abs(running.target - running.value)
        if (oldRem <= 1e-4) running.freshRow = true
        running.target = to
        const newRem = Math.abs(to - running.value)
        if (onEnter && !running.enter) running.enter = onEnter
        if (entering) running.entering = true
        if (coupled) running.coupled = coupled
        spring?.set(spring.target + newRem - oldRem)
        return
      }
      const rem = Math.abs(to - from)
      if (rem <= 1e-4) {
        onEnter?.()
        const wrapper = input.resize(key, to)
        if (wrapper) clearWrapper(wrapper)
        if (coupled) {
          const cWrapper = input.resize(coupled.key, coupled.base)
          if (cWrapper) clearWrapper(cWrapper)
        }
        return
      }
      growths.set(key, {
        value: from,
        target: to,
        opaque: Math.max(0, from),
        maskPx: 0,
        freshRow: true,
        entering: entering && from === 0,
        enterSpan: Math.min(28, Math.max(12, to)),
        enterProgress: 0,
        enter: onEnter,
        coupled,
      })
      if (!spring) spring = Spring.fromDuration(0, growthSpring())
      else spring.tune(growthSpring())
      spring.set(spring.target + rem)
      if (!wasGrowing) fresh = true
      stop ??= frameLoop.addMeasured(input.measure, step)
    },
    absorb(key: string, removed: number, base: number, to: number, enter?: (() => void) | boolean) {
      const running = growths.get(key)
      if (!running) {
        const from = base + removed
        if (Math.abs(to - from) <= 1e-4) {
          queueMicrotask(() => {
            if (typeof enter === "function") enter()
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
      if (typeof enter === "function" && !running.enter) running.enter = enter
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
      if (running.coupled) {
        const cWrapper = input.resize(running.coupled.key, running.coupled.base)
        if (cWrapper) clearWrapper(cWrapper)
      }
      growths.delete(key)
      if (spring) spring.set(Math.max(spring.value, spring.target - rem))
      if (!growths.size) {
        spring = undefined
        lastTake = 0
      }
    },
    hold(size: number) {
      held ??= Spring.fromDuration(0, growthSpring())
      held.tune(growthSpring())
      held.value += size
      held.set(0)
      stop ??= frameLoop.addMeasured(input.measure, step)
    },
    land(key: string, size: number) {
      const running = growths.get(key)
      if (running) {
        const rem = Math.abs(running.target - running.value)
        if (running.coupled) {
          const cWrapper = input.resize(running.coupled.key, running.coupled.base)
          if (cWrapper) clearWrapper(cWrapper)
        }
        growths.delete(key)
        if (spring) spring.set(Math.max(spring.value, spring.target - rem))
        if (!growths.size) {
          spring = undefined
          lastTake = 0
        }
      }
      const wrapper = input.resize(key, size)
      if (wrapper) clearWrapper(wrapper)
    },
    finish() {
      fresh = false
      lastTake = 0
      stop?.()
      stop = undefined
      spring = undefined
      held = undefined
      closing = false
      batch(() =>
        growths.forEach((growth, key) => {
          growth.enter?.()
          if (growth.coupled) {
            const cWrapper = input.resize(growth.coupled.key, growth.coupled.base)
            if (cWrapper) clearWrapper(cWrapper)
          }
          const wrapper = input.resize(key, growth.target)
          if (wrapper) clearWrapper(wrapper)
        }),
      )
      growths.clear()
    },
  }
}

function paintEdge(wrapper: HTMLElement, growth: Growth | undefined, fade: number) {
  const px = fade < 1 ? 0 : Math.round(fade)
  if (growth) {
    if (growth.maskPx === px) return
    growth.maskPx = px
  }
  if (px === 0) return wrapper.style.removeProperty("mask-image")
  wrapper.style.setProperty(
    "mask-image",
    `linear-gradient(to bottom, #000 calc(100% - ${px}px), rgba(0, 0, 0, 0.72) calc(100% - ${Math.round(px * 0.62)}px), rgba(0, 0, 0, 0.28) calc(100% - ${Math.round(px * 0.28)}px), transparent)`,
  )
}

function paintArrival(wrapper: HTMLElement, growth: Growth, shown: number) {
  const raw = Math.min(1, Math.max(0, shown / Math.max(1, growth.enterSpan)))
  growth.enterProgress = Math.min(growth.enterProgress + 0.34, Math.max(0.28, easeOut(raw)))
  const p = growth.enterProgress
  if (p >= 0.995) {
    growth.entering = false
    clearArrival(wrapper)
    return
  }
  wrapper.style.opacity = `${Math.round(p * 1000) / 1000}`
}

function clearArrival(wrapper: HTMLElement) {
  wrapper.style.removeProperty("opacity")
  wrapper.style.removeProperty("filter")
}

function clearWrapper(wrapper: HTMLElement) {
  paintEdge(wrapper, undefined, 0)
  clearArrival(wrapper)
}
