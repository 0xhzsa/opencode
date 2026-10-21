import { frameLoop, prefersReducedMotion, Spring } from "@opencode/ui/motion"
import { growthSpring } from "./row-growth"

type Rect = { x: number; y: number; w: number; h: number }

type Flight = {
  text: HTMLElement
  layer: HTMLElement
  from: Rect
  expire: ReturnType<typeof setTimeout>
  source?: HTMLElement
}

// The sent text rises from behind the composer, clipped to its timeline's visible viewport. The real bubble stays
// hidden until the flight lands on it.
const waiting = new Map<string, Flight>()

// A bubble that mounted before its flight was prepared, as when a queued prompt's row leaves the queue a moment after
// its message reaches the timeline. A flight prepared soon after still lands on it.
const unclaimed = new Map<string, { bubble: HTMLElement; at: number }>()

/**
 * Holds a copy of the composer's text, or a queued prompt's row, where it is for the bubble that `id` becomes. A
 * `source` hides as the copy takes off from it.
 */
export function prepareSendFlight(id: string, editor: HTMLElement | undefined, source?: HTMLElement) {
  if (!editor?.isConnected || prefersReducedMotion()) return
  const range = document.createRange()
  range.selectNodeContents(editor)
  const box = range.getBoundingClientRect()

  if (box.width < 1 || box.height < 1) return
  const style = getComputedStyle(editor)
  const text = document.createElement("div")
  text.setAttribute("aria-hidden", "true")
  Object.assign(text.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: `${Math.ceil(box.width) + 1}px`,
    transformOrigin: "0 0",
    transform: `translate3d(${box.left}px, ${box.top}px, 0)`,
    font: style.font,
    letterSpacing: style.letterSpacing,
    color: style.color,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  })
  editor.childNodes.forEach((node) => text.append(node.cloneNode(true)))
  text.querySelectorAll("[contenteditable]").forEach((node) => node.removeAttribute("contenteditable"))

  const layer = document.createElement("div")
  layer.setAttribute("aria-hidden", "true")
  layer.dataset.sendFlight = ""
  Object.assign(layer.style, {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
    zIndex: "1",
    contain: "strict",
    overflow: "hidden",
    maskImage: "linear-gradient(to bottom, #000 calc(100% - 16px), transparent)",
    // The destination supplies its viewport before the copy may paint.
    visibility: "hidden",
  })
  document.body.append(layer)

  layer.append(text)
  waiting.get(id)?.layer.remove()
  waiting.set(id, {
    text,
    layer,
    source,
    from: { x: box.left, y: box.top, w: box.width, h: box.height },
    expire: setTimeout(() => {
      waiting.delete(id)
      text
        .animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 110,
          easing: "cubic-bezier(.4,0,1,1)",
          fill: "forwards",
        })
        .finished.finally(() => layer.remove())
    }, 700),
  })

  const early = unclaimed.get(id)
  unclaimed.delete(id)
  if (early && performance.now() - early.at < 400 && early.bubble.isConnected) landSendFlight(id, early.bubble)
}

/** Flies the waiting copy for `id` onto `bubble`. Returns false when nothing was waiting for it. */
export function landSendFlight(id: string, bubble: HTMLElement) {
  const flight = waiting.get(id)

  if (!flight) {
    const now = performance.now()
    unclaimed.forEach((entry, key) => now - entry.at >= 400 && unclaimed.delete(key))
    unclaimed.set(id, { bubble, at: now })

    return false
  }
  unclaimed.delete(id)
  waiting.delete(id)
  clearTimeout(flight.expire)

  if (prefersReducedMotion()) {
    flight.layer.remove()

    return false
  }

  const style = getComputedStyle(bubble)
  const viewport = bubble
    .closest('[data-slot="session-timeline-scroll"]')
    ?.parentElement?.querySelector<HTMLElement>('[data-slot="session-timeline-visible"]')

  if (!viewport) {
    flight.layer.remove()

    return false
  }
  viewport.append(flight.layer)
  const left = parseFloat(style.paddingLeft) || 0
  const right = parseFloat(style.paddingRight) || 0
  const top = parseFloat(style.paddingTop) || 0
  const bottom = parseFloat(style.paddingBottom) || 0

  const start = {
    x: flight.from.x - left,
    y: flight.from.y - top,
    w: flight.from.w + left + right,
    h: flight.from.h + top + bottom,
  }

  const host = document.createElement("div")
  host.setAttribute("aria-hidden", "true")
  host.dataset.component = "user-message"
  host.dataset.flight = ""
  Object.assign(host.style, { position: "fixed", left: "0", top: "0", transformOrigin: "0 0", opacity: "0" })
  // SAFETY: a deep clone has the same element type as its source.
  const copy = bubble.cloneNode(true) as HTMLElement
  Object.assign(copy.style, { width: "100%", height: "100%", margin: "0", boxSizing: "border-box" })
  host.append(copy)
  flight.text.before(host)
  bubble.style.opacity = "0"
  flight.source?.style.setProperty("visibility", "hidden")

  const spring = Spring.fromDuration(0, growthSpring()).set(1)
  let rect = bubble.getBoundingClientRect()
  let clip = viewport.getBoundingClientRect()
  let pending = bubble.closest('[data-component="user-message"]')?.hasAttribute("data-pending") ?? false

  const land = () => {
    bubble.style.removeProperty("opacity")
    flight.layer.remove()
  }

  frameLoop.addMeasured(
    () => {
      rect = bubble.getBoundingClientRect()
      clip = viewport.getBoundingClientRect()
      pending = bubble.closest('[data-component="user-message"]')?.hasAttribute("data-pending") ?? false
    },
    (dt) => {
      if (!bubble.isConnected || !viewport.isConnected || rect.width < 1) {
        land()

        return false
      }

      // A delayed frame must not skip most of a new flight before its first paint.
      const elapsed = Math.min(dt, 1 / 60)
      spring.tune(growthSpring())
      const p = Math.min(1, Math.max(0, spring.step(elapsed)))
      flight.layer.style.visibility = "visible"
      host.toggleAttribute("data-pending", pending)
      const at = {
        x: start.x + (rect.left - start.x) * p,
        y: start.y + (rect.top - start.y) * p,
        w: start.w + (rect.width - start.w) * p,
        h: start.h + (rect.height - start.h) * p,
      }
      host.style.width = `${rect.width}px`
      host.style.height = `${rect.height}px`
      host.style.transform = `translate3d(${at.x - clip.left}px, ${at.y - clip.top}px, 0) scale(${at.w / rect.width}, ${at.h / rect.height})`
      host.style.opacity = `${Math.min(1, p / 0.5)}`

      flight.text.style.transform = `translate3d(${at.x + left - clip.left}px, ${at.y + top - clip.top}px, 0)`
      flight.text.style.opacity = `${Math.max(0, 1 - p / 0.4)}`

      if (!spring.resting) return true
      land()

      return false
    },
  )

  return true
}
