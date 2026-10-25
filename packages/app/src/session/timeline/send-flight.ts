import { prefersReducedMotion, springAt, springSettle } from "@opencode/ui/motion"
import { motionTuning } from "@opencode/ui/motion-tuning"
import { growthSpring } from "./row-growth"

type Rect = { x: number; y: number; w: number; h: number }

type Flight = {
  at: number
  text: HTMLElement
  layer: HTMLElement
  from: Rect
  /** How far the composer had scrolled through a prompt taller than it, from 0 at its start to 1 at its end. */
  reveal: number
  /** The copy's full text: `above` of it sits over the lines that take off. */
  above: number
  textHeight: number
  expire: ReturnType<typeof setTimeout>
  source?: HTMLElement
}

// The sent text rises from behind the composer, clipped to its timeline's visible viewport. The real bubble stays
// hidden until the flight lands on it.
const waiting = new Map<string, Flight>()

// A bubble that mounted before its flight was prepared, as when a queued prompt's row leaves the queue a moment after
// its message reaches the timeline. A flight prepared soon after still lands on it.
const unclaimed = new Map<
  string,
  { bubble: HTMLElement; at: number; follow?: (carrier: HTMLElement) => { offset: number; stop: () => void } }
>()

/**
 * Holds a copy of the composer's text, or a queued prompt's row, where it is for the bubble that `id` becomes. A
 * `source` hides as the copy takes off from it.
 */
export function prepareSendFlight(id: string, editor: HTMLElement | undefined, source?: HTMLElement) {
  if (!editor?.isConnected || document.hidden || prefersReducedMotion()) return
  const range = document.createRange()
  range.selectNodeContents(editor)
  const box = range.getBoundingClientRect()

  if (box.width < 1 || box.height < 1) return
  // Only the lines the composer shows take off; a long prompt's scrolled-out lines stay hidden.
  const view = scroller(editor)?.getBoundingClientRect()
  const above = Math.max(0, (view?.top ?? box.top) - box.top)
  const below = Math.max(0, box.bottom - (view?.bottom ?? box.bottom))
  const style = getComputedStyle(editor)
  const zoom = cssZoom(editor)
  const text = document.createElement("div")
  text.setAttribute("aria-hidden", "true")
  Object.assign(text.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: `${Math.ceil(box.width / zoom) + 1}px`,
    transformOrigin: "0 0",
    transform: `translate3d(${box.left}px, ${box.top}px, 0)`,
    font: style.font,
    letterSpacing: style.letterSpacing,
    color: style.color,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    clipPath: above || below ? `inset(${above / zoom}px -8px ${below / zoom}px -8px)` : "",
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
    at: performance.now(),
    text,
    layer,
    source,
    from: { x: box.left, y: box.top + above, w: box.width, h: Math.max(1, box.height - above - below) },
    reveal: above + below > 0 ? above / (above + below) : 0,
    above,
    textHeight: box.height,
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
  if (early && performance.now() - early.at < 400 && early.bubble.isConnected)
    landSendFlight(id, early.bubble, early.follow)
}

/** Whether a copy waits to fly onto the bubble that `id` becomes. */
export function sendFlightPending(id: string) {
  return waiting.has(id)
}

/**
 * Flies the waiting copy for `id` onto `bubble`, measuring both ends once. `follow` moves the copy with the bubble's
 * row from then on and reports how far that row is drawn from its resting slot. Returns false when nothing was waiting.
 */
export function landSendFlight(
  id: string,
  bubble: HTMLElement,
  follow?: (carrier: HTMLElement) => { offset: number; stop: () => void },
) {
  const flight = waiting.get(id)

  if (!flight) {
    const now = performance.now()
    unclaimed.forEach((entry, key) => now - entry.at >= 400 && unclaimed.delete(key))
    unclaimed.set(id, { bubble, at: now, follow })

    return false
  }
  unclaimed.delete(id)
  waiting.delete(id)
  clearTimeout(flight.expire)

  if (document.hidden || prefersReducedMotion()) {
    flight.layer.remove()

    return false
  }

  const style = getComputedStyle(bubble)
  const viewport = bubble
    .closest('[data-slot="session-timeline-scroll"]')
    ?.parentElement?.querySelector<HTMLElement>('[data-slot="session-timeline-visible"]')
  const screen = bubble.getBoundingClientRect()

  if (!viewport || screen.width < 1) {
    flight.layer.remove()

    return false
  }
  viewport.append(flight.layer)
  // DOM rects include CSS zoom; compositor keyframes and the row follower use local CSS pixels.
  const zoom = cssZoom(viewport)
  const rect = {
    left: screen.left / zoom,
    top: screen.top / zoom,
    width: screen.width / zoom,
    height: screen.height / zoom,
  }
  const clip = viewport.getBoundingClientRect()
  const left = parseFloat(style.paddingLeft) || 0
  const right = parseFloat(style.paddingRight) || 0
  const top = parseFloat(style.paddingTop) || 0
  const bottom = parseFloat(style.paddingBottom) || 0

  const start = {
    x: flight.from.x / zoom - left,
    y: flight.from.y / zoom - top,
    w: flight.from.w / zoom + left + right,
    h: flight.from.h / zoom + top + bottom,
  }

  const carrier = document.createElement("div")
  Object.assign(carrier.style, { position: "absolute", inset: "0" })
  const host = document.createElement("div")
  host.setAttribute("aria-hidden", "true")
  host.dataset.component = "user-message"
  host.dataset.flight = ""
  host.toggleAttribute("data-pending", bubble.closest('[data-component="user-message"]')?.hasAttribute("data-pending"))
  Object.assign(host.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    transformOrigin: "0 0",
  })
  // SAFETY: a deep clone has the same element type as its source.
  const copy = bubble.cloneNode(true) as HTMLElement
  Object.assign(copy.style, { width: "100%", height: "100%", margin: "0", boxSizing: "border-box" })
  host.append(copy)
  carrier.append(host)
  flight.text.before(carrier)
  bubble.style.opacity = "0"
  flight.source?.style.setProperty("visibility", "hidden")
  const followed = follow?.(carrier)
  // The flight aims at the bubble's resting slot; the carrier adds wherever its row is drawn on the way there.
  const end = { x: rect.left, y: rect.top - (followed?.offset ?? 0), w: rect.width, h: rect.height }

  // The copy wears a lone bubble's corners, since its host carries no run. The clip draws them instead, easing them into
  // the bubble's own and holding them steady on screen as the copy scales.
  const from = corners(getComputedStyle(copy))
  const to = corners(style)
  copy.style.borderRadius = "0"
  // A prompt that wraps differently in its bubble crosses over quickly, so the two wraps barely overlap.
  const rewraps = Math.abs(rect.height - top - bottom - flight.textHeight / zoom) > 2
  const spring = growthSpring()
  const omega = (2 * Math.PI) / spring.duration
  const zeta = 1 - spring.bounce
  const settle = springSettle(1, 0, omega, zeta, 0.001)
  const count = Math.max(2, Math.ceil(settle * 60))
  const progress = Array.from({ length: count + 1 }, (_, index) =>
    index === count ? 1 : Math.min(1, Math.max(0, 1 - springAt(1, 0, omega, zeta, (settle * index) / count)[0])),
  )
  const poses = progress.map((p) => {
    const at = {
      x: start.x + (end.x - start.x) * p,
      y: start.y + (end.y - start.y) * p,
      w: start.w + (end.w - start.w) * p,
      h: start.h + (end.h - start.h) * p,
    }
    // The copy keeps its proportions, so its text never squishes: it scales with the width and shows as much of its
    // height as the flight has reached, from the part the composer had scrolled to.
    const scale = at.w / rect.width
    const shown = Math.min(rect.height, at.h / scale)
    const hidden = flight.reveal * (rect.height - shown)
    const round = from.map((corner, index) => `${(corner + (to[index]! - corner) * p) / scale}px`).join(" ")
    return {
      host: {
        transform: `translate(${at.x - clip.left / zoom}px, ${at.y - hidden * scale - clip.top / zoom}px) scale(${scale})`,
        clipPath: `inset(${hidden}px 0 ${Math.max(0, rect.height - hidden - shown)}px 0 round ${round})`,
        opacity: rewraps ? Math.min(1, Math.max(0, (p - 0.1) / 0.3)) : Math.min(1, p / 0.5),
      },
      text: {
        transform: `translate(${at.x + left - clip.left / zoom}px, ${at.y + top - (flight.above + clip.top) / zoom}px)`,
        opacity: Math.max(0, 1 - p / (rewraps ? 0.25 : 0.4)),
      },
    }
  })
  const timing = { duration: settle * 1000 * motionTuning.timeScale(), easing: "linear", fill: "forwards" as const }
  const animations = [
    host.animate(
      poses.map((pose) => pose.host),
      timing,
    ),
    flight.text.animate(
      poses.map((pose) => pose.text),
      timing,
    ),
  ]
  // Sends can share their first paint after a busy frame. Preserve their distinct launch times instead of restarting
  // them together, which makes their copies collide along the same path out of the composer.
  const launched = Math.min(timing.duration, performance.now() - flight.at)
  animations.forEach((animation) => (animation.currentTime = launched))
  flight.layer.style.visibility = "visible"

  const land = () => {
    document.removeEventListener("visibilitychange", onVisibilityChange)
    followed?.stop()
    bubble.style.removeProperty("opacity")
    flight.layer.remove()
  }

  function onVisibilityChange() {
    if (!document.hidden) return
    animations.forEach((animation) => animation.cancel())
  }
  document.addEventListener("visibilitychange", onVisibilityChange)
  void Promise.all(animations.map((animation) => animation.finished)).then(land, land)

  return true
}

function corners(style: CSSStyleDeclaration) {
  return [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ].map((value) => parseFloat(value) || 0)
}

function cssZoom(element: Element): number {
  return (Number(getComputedStyle(element).zoom) || 1) * (element.parentElement ? cssZoom(element.parentElement) : 1)
}

// The box that clips the composer's text, when the prompt is taller than it.
function scroller(editor: HTMLElement) {
  for (let node = editor.parentElement; node && node !== document.body; node = node.parentElement)
    if (node.scrollHeight > node.clientHeight + 1 && getComputedStyle(node).overflowY !== "visible") return node
  return undefined
}
