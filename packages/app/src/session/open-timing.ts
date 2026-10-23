// Always-on timing for each session open: route change → transcript requests → store publish →
// first and newest timeline row painted → idle. Paint uses the e2e navigation milestone rules
// (`e2e/performance/timeline/navigation-milestones.ts`): sample after rAF + setTimeout, and call a
// milestone stable after three consecutive matching samples. Results go to a ring buffer on
// `window.__opencodeSessionOpens` and one `[session-open]` console line, which the desktop app
// writes to `renderer.log`.

type SessionOpenRequest = {
  path: string
  startMs: number
  headersMs?: number
  status?: number
  // content-length on the wire, so compressed bytes when the server compresses.
  bytes?: number
  error?: boolean
}

type SessionOpen = {
  sessionID: string
  at: string
  // A pointer or key press up to a second before the route change starts the clock instead.
  input?: string
  routeMs: number
  cached: { messages: number; view?: boolean }
  requests: SessionOpenRequest[]
  storedMs?: number
  messages?: number
  firstRowMs?: number
  firstRowStableMs?: number
  newestRowMs?: number
  newestRowStableMs?: number
  idleMs?: number
  frames: number
  maxFrameGapMs: number
  outcome?: "idle" | "replaced" | "timeout"
}

declare global {
  interface Window {
    __opencodeSessionOpens?: SessionOpen[]
  }
}

type Active = {
  entry: SessionOpen
  t0: number
  last: number
  pending: number
  messages: () => number
  streak: { first: number; newest: number; idle: number }
  timer: ReturnType<typeof setTimeout>
}

const bufferSize = 50

const inputWindowMs = 1_000

const timeoutMs = 15_000

const stableSamples = 3

const sessionPath = /^\/api\/session\/([^/]+)(?:\/(message|inbox))?$/

let active: Active | undefined

let lastInput = { at: -Infinity, type: "" }

let listening = false

const round = (value: number) => Math.round(value * 10) / 10

function listen() {
  if (listening || typeof document === "undefined") return
  listening = true

  const mark = (event: Event) => {
    lastInput = { at: event.timeStamp, type: event.type }
  }

  document.addEventListener("pointerdown", mark, { capture: true, passive: true })
  document.addEventListener("keydown", mark, { capture: true, passive: true })
}

function finish(outcome: NonNullable<SessionOpen["outcome"]>) {
  const current = active

  if (!current) return
  active = undefined
  clearTimeout(current.timer)
  current.entry.outcome = outcome
  const buffer = (window.__opencodeSessionOpens ??= [])
  buffer.push(current.entry)

  if (buffer.length > bufferSize) buffer.splice(0, buffer.length - bufferSize)
  console.info(`[session-open] ${JSON.stringify(current.entry)}`)
}

function inView(element: Element, bounds: DOMRect | undefined) {
  const rect = element.getBoundingClientRect()
  const top = bounds?.top ?? 0
  const bottom = bounds?.bottom ?? innerHeight

  return rect.height > 0 && rect.bottom > top && rect.top < bottom
}

function sample(current: Active) {
  requestAnimationFrame(() => {
    setTimeout(() => {
      if (active !== current) return
      const now = performance.now()
      const entry = current.entry
      entry.frames++
      entry.maxFrameGapMs = Math.max(entry.maxFrameGapMs, round(now - current.last))
      current.last = now
      const at = round(now - current.t0)

      const content = [...document.querySelectorAll("[data-timeline-virtual-content]")].find((element) =>
        element.checkVisibility({ checkVisibilityCSS: true }),
      )

      const bounds = content?.closest('[data-slot="session-timeline-scroll"]')?.getBoundingClientRect()
      const first = !!content && [...content.querySelectorAll("[data-timeline-key]")].some((row) => inView(row, bounds))
      // The bottom spacer follows the last row, so it is in view only when the newest row is.
      const spacer = content?.querySelector('[data-timeline-row="bottom-spacer"]')
      const newest = first && !!spacer && inView(spacer, bounds)
      const streak = current.streak
      streak.first = first ? streak.first + 1 : 0
      streak.newest = newest ? streak.newest + 1 : 0

      if (first) entry.firstRowMs ??= at

      if (newest) entry.newestRowMs ??= at

      if (streak.first === stableSamples) entry.firstRowStableMs ??= at

      if (streak.newest === stableSamples) entry.newestRowStableMs ??= at
      const empty = entry.storedMs !== undefined && entry.messages === 0
      const idle = current.pending === 0 && entry.storedMs !== undefined && (newest || empty)
      streak.idle = idle ? streak.idle + 1 : 0

      if (streak.idle === stableSamples) {
        entry.idleMs = at
        finish("idle")

        return
      }

      sample(current)
    }, 0)
  })
}

export const sessionOpenTiming = {
  start(sessionID: string, messages: () => number) {
    if (typeof window === "undefined") return
    listen()
    finish("replaced")
    const route = performance.now()
    const input = route - lastInput.at <= inputWindowMs ? lastInput : undefined
    const t0 = input?.at ?? route

    const current: Active = {
      entry: {
        sessionID,
        at: new Date(performance.timeOrigin + t0).toISOString(),
        input: input?.type,
        routeMs: round(route - t0),
        cached: { messages: messages() },
        requests: [],
        frames: 0,
        maxFrameGapMs: 0,
      },
      t0,
      last: route,
      pending: 0,
      messages,
      streak: { first: 0, newest: 0, idle: 0 },
      timer: setTimeout(() => finish("timeout"), timeoutMs),
    }

    active = current
    sample(current)
  },
  view(cached: boolean) {
    if (active && active.entry.cached.view === undefined) active.entry.cached.view = cached
  },
  stored(sessionID: string) {
    if (!active || active.entry.sessionID !== sessionID || active.entry.storedMs !== undefined) return
    active.entry.storedMs = round(performance.now() - active.t0)
    active.entry.messages = active.messages()
  },
  fetch(base: typeof globalThis.fetch): typeof globalThis.fetch {
    return Object.assign(
      (resource: RequestInfo | URL, init?: RequestInit) => {
        const current = active
        const url = current && new URL(resource instanceof Request ? resource.url : resource.toString(), location.href)
        const match = url && sessionPath.exec(url.pathname)

        if (!current || !match || decodeURIComponent(match[1]!) !== current.entry.sessionID) return base(resource, init)

        const request: SessionOpenRequest = {
          path: `${match[2] ?? "session"}${url.search.replace(/cursor=[^&]*/, "cursor")}`,
          startMs: round(performance.now() - current.t0),
        }

        current.entry.requests.push(request)
        current.pending++

        const response = base(resource, init)

        void response
          .then(
            (value) => {
              request.headersMs = round(performance.now() - current.t0)
              request.status = value.status
              const length = value.headers.get("content-length")

              if (length !== null) request.bytes = Number(length)
            },
            () => {
              request.error = true
            },
          )
          .finally(() => {
            current.pending--
          })

        return response
      },
      { preconnect: () => {} },
    )
  },
}
