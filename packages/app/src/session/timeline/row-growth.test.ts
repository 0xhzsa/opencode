import { describe, expect, test } from "bun:test"
import { createRowGrowth, workingHandoffPose } from "./row-growth"

function setup() {
  const wrapper = document.createElement("div")
  const sizes: number[] = []
  const frames: { pending: number; held: number }[] = []

  const growth = createRowGrowth({
    measure: () => {},
    resize: (key, size) => {
      if (key !== "row") return false
      sizes.push(size)

      return wrapper
    },
    below: () => true,
    settle: (state) => frames.push(state),
  })

  return { growth, sizes, wrapper, frames }
}

async function settle(growth: ReturnType<typeof createRowGrowth>, frames: { held: number }[]) {
  const deadline = performance.now() + 3000

  while ((growth.target("row") !== undefined || frames.at(-1)?.held !== 0) && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 16))
}

describe("row growth", () => {
  test("eases a row on the layout grid, behind a soft edge that clears when it lands", async () => {
    const { growth, sizes, wrapper, frames } = setup()
    growth.grow("row", 0, 120.5)
    expect(growth.target("row")).toBe(120.5)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(wrapper.style.getPropertyValue("mask-image")).toContain("linear-gradient")

    await settle(growth, frames)
    expect(growth.target("row")).toBeUndefined()
    expect(sizes.at(-1)).toBe(120.5)
    expect(sizes.every((size, index) => Number.isInteger(size * 64) && size >= (sizes[index - 1] ?? 0))).toBe(true)
    expect(sizes.slice(0, -1).some((size) => !Number.isInteger(size))).toBe(true)
    expect(wrapper.style.getPropertyValue("mask-image")).toBe("")
  })

  test("bends a running growth toward a new height instead of restarting it", async () => {
    const { growth, sizes, frames } = setup()
    growth.grow("row", 0, 100)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const reached = sizes.at(-1) ?? 0
    growth.grow("row", 0, 200)

    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(sizes.at(-1)).toBeGreaterThanOrEqual(reached)

    await settle(growth, frames)
    expect(sizes.at(-1)).toBe(200)
  })

  test("lands on a nearer target instead of passing it and coming back", async () => {
    const { growth, sizes, frames } = setup()
    growth.grow("row", 0, 200)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const near = (sizes.at(-1) ?? 0) + 2
    growth.grow("row", 0, near)

    await settle(growth, frames)
    expect(sizes.at(-1)).toBe(near)
    expect(sizes.every((size) => size <= near)).toBe(true)
  })

  test("reports once per frame how far the rows still have to grow", async () => {
    const { growth, frames } = setup()
    growth.grow("row", 0, 80)

    await settle(growth, frames)
    expect(frames[0]!.pending).toBeGreaterThan(0)
    expect(frames.at(-1)).toEqual({ pending: 0, held: 0 })
    expect(frames.every((frame, index) => frame.pending <= (frames[index - 1]?.pending ?? Infinity))).toBe(true)
  })

  test("closes a held gap on the same spring", async () => {
    const { growth, frames } = setup()
    growth.hold(40)

    await settle(growth, frames)
    expect(frames[0]!.held).toBeGreaterThan(0)
    expect(frames[0]!.held).toBeLessThanOrEqual(40)
    expect(frames.at(-1)!.held).toBe(0)
    expect(frames.every((frame, index) => frame.held <= (frames[index - 1]?.held ?? 40))).toBe(true)
  })

  test("fills a held gap with growth below it before closing the rest", async () => {
    const { growth, sizes, frames } = setup()
    growth.hold(40)
    growth.grow("row", 0, 30)

    await settle(growth, frames)
    expect(sizes.at(-1)).toBe(30)
    expect(sizes.slice(0, -1).every((size, index) => frames[index]!.held === 40 - size)).toBe(true)
    expect(frames.at(-1)!.held).toBe(0)
  })

  test("lands rows at once", () => {
    const { growth, sizes, wrapper } = setup()
    growth.grow("row", 10, 300)
    growth.land("row", 280)
    expect(sizes.at(-1)).toBe(280)
    expect(growth.target("row")).toBeUndefined()

    growth.grow("row", 0, 90)
    growth.finish()
    expect(sizes.at(-1)).toBe(90)
    expect(growth.target("row")).toBeUndefined()
    expect(wrapper.style.getPropertyValue("mask-image")).toBe("")
  })

  test("absorbs a removed neighbour's height and closes the gap on the shared spring", async () => {
    const { growth, sizes, frames } = setup()
    growth.absorb("row", 120, 28, 28)
    expect(growth.target("row")).toBe(28)

    await settle(growth, frames)
    expect(growth.target("row")).toBeUndefined()
    expect(sizes[0]).toBeLessThan(148)
    expect(sizes[0]).toBeGreaterThan(28)
    expect(sizes.at(-1)).toBe(28)
    expect(sizes.every((size, index) => size <= (sizes[index - 1] ?? 148))).toBe(true)
  })

  test("computes WorkingHandoffPose curves for copy handoff and reduced motion", () => {
    expect(workingHandoffPose(0)).toEqual({
      indicatorOpacity: 1,
      indicatorBlur: 0,
      indicatorScale: 1,
      copyOpacity: 0,
      copyBlur: 6,
      copyScale: 0.6,
    })
    const mid = workingHandoffPose(0.5, true, false)
    expect(mid.indicatorOpacity).toBeLessThan(0.5)
    expect(mid.indicatorBlur).toBeGreaterThan(3)
    expect(mid.indicatorScale).toBeLessThan(0.75)
    expect(mid.copyOpacity).toBeGreaterThan(0.5)
    expect(mid.copyBlur).toBeLessThan(4.5)
    expect(mid.copyScale).toBeGreaterThan(0.8)
    expect(workingHandoffPose(1, true, false)).toEqual({
      indicatorOpacity: 0,
      indicatorBlur: 6,
      indicatorScale: 0.5,
      copyOpacity: 1,
      copyBlur: 0,
      copyScale: 1,
    })
    expect(workingHandoffPose(0.5, true, true)).toEqual({
      indicatorOpacity: 0.5,
      indicatorBlur: 0,
      indicatorScale: 1,
      copyOpacity: 0.5,
      copyBlur: 0,
      copyScale: 1,
    })
  })

  test("maintains a continuous feather cushion across streaming target advances", async () => {
    const { growth, sizes, wrapper, frames } = setup()
    growth.grow("row", 46, 50, false, undefined, true)
    await Bun.sleep(25)
    const mask = wrapper.style.getPropertyValue("mask-image")
    const px = Number(mask.match(/calc\(100% - (\d+)px\)/)?.[1] ?? 0)
    expect(px).toBeGreaterThanOrEqual(16)
    growth.grow("row", 46, 90, false, undefined, true)
    await settle(growth, frames)
    expect(sizes.at(-1)).toBe(90)
    expect(wrapper.style.getPropertyValue("mask-image")).toBe("")
  })
})
