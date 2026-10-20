import { describe, expect, test } from "bun:test"
import { createRowGrowth } from "./row-growth"

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
})
