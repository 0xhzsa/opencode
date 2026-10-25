import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { landSendFlight, prepareSendFlight } from "./send-flight"

type Played = {
  element: Element
  frames: Keyframe[]
  animation: { currentTime: number; cancel: () => void; finished: Promise<unknown> }
  finish: () => void
}

// happy-dom has no Web Animations; record what would have been handed to the compositor.
let played: Played[] = []
const native = Object.getOwnPropertyDescriptor(Element.prototype, "animate")

beforeEach(() => {
  played = []
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value(this: Element, frames: Keyframe[]) {
      const finished = Promise.withResolvers<unknown>()
      const animation = {
        currentTime: 0,
        cancel: () => finished.reject(new Error("cancelled")),
        finished: finished.promise,
      }
      played.push({ element: this, frames, animation, finish: () => finished.resolve(animation) })
      return animation
    },
  })
})

afterEach(() => {
  if (native) Object.defineProperty(Element.prototype, "animate", native)
  else delete (Element.prototype as Partial<Element>).animate
})

function setup() {
  const range = document.createRange()
  const mocks = [
    spyOn(range, "getBoundingClientRect").mockReturnValue(new DOMRect(380, 780, 60, 20)),
    spyOn(document, "createRange").mockReturnValue(range),
  ]
  const root = document.createElement("div")
  const scroll = document.createElement("div")
  scroll.dataset.slot = "session-timeline-scroll"
  const viewport = document.createElement("div")
  viewport.dataset.slot = "session-timeline-visible"
  const editor = document.createElement("div")
  editor.textContent = "send"
  root.append(scroll, viewport, editor)
  document.body.replaceChildren(root)
  const bubble = (top: number) => {
    const element = document.createElement("div")
    element.textContent = "send"
    scroll.append(element)
    mocks.push(spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(1000, top, 80, 36)))
    return element
  }
  return { editor, viewport, bubble, restore: () => mocks.forEach((mock) => mock.mockRestore()) }
}

const hosts = () => played.filter((item) => item.element instanceof HTMLElement && item.element.dataset.flight === "")
const top = (frame: Keyframe) => Number(String(frame.transform).match(/translate\([^,]+, ([-\d.]+)px\)/)![1])

test("sends that share their first paint keep their distinct launch times", () => {
  const clock = spyOn(performance, "now").mockReturnValue(0)
  const { editor, bubble, restore } = setup()
  try {
    const bubbles = [0, 100, 150].map((at, index) => {
      clock.mockReturnValue(at)
      prepareSendFlight(`shared-${index}`, editor)
      return bubble(300 + index * 41)
    })
    // All three messages were submitted before the renderer could paint any of their flights.
    clock.mockReturnValue(180)
    bubbles.forEach((element, index) => expect(landSendFlight(`shared-${index}`, element)).toBe(true))
    expect(hosts().map((item) => item.animation.currentTime)).toEqual([180, 80, 30])
  } finally {
    restore()
    clock.mockRestore()
  }
})

test("aims at the bubble's resting slot while its row is still drawn away from it", async () => {
  const { editor, viewport, bubble, restore } = setup()
  try {
    prepareSendFlight("moving", editor)
    const element = bubble(300)
    const carrier: HTMLElement[] = []
    const stopped: boolean[] = []
    landSendFlight("moving", element, (value) => {
      carrier.push(value)
      return { offset: 30, stop: () => stopped.push(true) }
    })
    const host = hosts()[0]!
    // The carrier draws the row's remaining 30 px; the flight itself ends where the bubble rests.
    expect(top(host.frames.at(-1)!)).toBe(270)
    expect(carrier[0]?.contains(host.element)).toBe(true)
    expect(element.style.opacity).toBe("0")
    played.forEach((item) => item.finish())
    await Promise.resolve()
    await Promise.resolve()
    expect(element.style.opacity).toBe("")
    expect(stopped).toEqual([true])
    expect(viewport.querySelector("[data-send-flight]")).toBeNull()
  } finally {
    restore()
  }
})

test("lands in local CSS pixels when its viewport is zoomed", async () => {
  const { editor, viewport, bubble, restore } = setup()
  viewport.style.zoom = "0.9"
  try {
    prepareSendFlight("zoomed", editor)
    const element = bubble(300)
    landSendFlight("zoomed", element, () => ({ offset: 30, stop: () => {} }))
    const host = hosts()[0]!
    expect(top(host.frames.at(-1)!)).toBeCloseTo(300 / 0.9 - 30)
    expect(parseFloat((host.element as HTMLElement).style.width)).toBeCloseTo(80 / 0.9)
    played.forEach((item) => item.finish())
    await Promise.resolve()
    await Promise.resolve()
    expect(element.style.opacity).toBe("")
  } finally {
    restore()
  }
})
