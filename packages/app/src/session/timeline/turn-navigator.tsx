import type { SessionMessageAssistant, SessionMessageInfo, SessionMessageUser } from "@opencode/client/promise"
import { frameLoop, prefersReducedMotion, Spring } from "@opencode/ui/motion"
import { createEffect, createMemo, createSelector, For, onCleanup, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { readPromptPresentation } from "@/composer/comment-note"
import { useServerSDK } from "@/runtime/server/client"

const turnPageLimit = 200

// Bound preview work without cutting short the text that fits in the card.
const previewLength = 800

// Keep index loading clear of session entry, tab switch rendering and the timeline's own history requests.
const railDelay = 1000

// The rail lists at most this many of the newest turns.
const indexLimit = 1000

// Resting on an unloaded turn fetches its reply; sweeping across the rail fetches nothing.
const replyHoverDelay = 150

const previewHoverDelay = 100

// Messages read back from the next turn to find an unloaded turn's reply.
const replyScanLimit = 20

// Ticks within this many pixels of the pointer swell towards it, like a dock.
const waveRadius = 48

const tickWidths = { default: 7, active: 12, peak: 22 }

// The prompt's first line sits level with its tick: 12px card padding, then half a 20px line.
const previewAnchor = 22

// The preview at its tallest, with both texts clamped. Clamping to it keeps the card still while a reply loads.
const previewMaxHeight = 212

type TurnNavigatorProps = {
  sessionID: string
  /** Loaded messages that have timeline rows; excludes queued inbox items. */
  messages: Accessor<SessionMessageInfo[]>
  /** Whether the loaded messages reach the start of the session, making the index redundant. */
  complete: Accessor<boolean>
  /** Whether the timeline is loading its own history; the index waits until it has been idle for a while. */
  historyLoading: Accessor<boolean>
  assistantMessagesByParent: Accessor<Map<string, SessionMessageAssistant[]>>
  revertMessageID: Accessor<string | undefined>
  visibleUserMessageIDs: Accessor<ReadonlySet<string>>
  onSelect: (id: string) => void
}

/**
 * A mouse rail beside the timeline. Older turns come from the user-message index; hovering one loads only its
 * latest reply. Keyboard users already have the previous and next message commands.
 *
 * Loading is deferred, then the rail appears with every turn so it never grows under the pointer.
 */
export function TurnNavigator(props: TurnNavigatorProps) {
  const sdk = useServerSDK()
  const [state, setState] = createStore<{ engaged: boolean; index?: Map<string, string> }>({ engaged: false })
  let root: HTMLDivElement | undefined

  const abort = new AbortController()
  onCleanup(() => abort.abort())

  // Newest first, so a capped index still meets the loaded tail.
  const loadIndex = async (cursor?: string, count = 0): Promise<[string, string][]> => {
    const page = await sdk.api.message.list(
      { sessionID: props.sessionID, type: "user", includeFiles: false, limit: turnPageLimit, cursor },
      { signal: abort.signal },
    )

    const turns = page.data.flatMap((message): [string, string][] =>
      message.type === "user" ? [[message.id, promptPreview(message)]] : [],
    )

    if (page.data.length < turnPageLimit || !page.cursor.next || count + turns.length >= indexLimit) return turns

    return [...turns, ...(await loadIndex(page.cursor.next, count + turns.length))]
  }

  createEffect(() => {
    if (state.engaged || props.historyLoading()) return

    const timer = setTimeout(() => {
      // Touch-only devices never load the rail.
      if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return
      setState("engaged", true)

      if (props.complete()) return
      // Plain state rather than a resource: a pending resource would suspend the timeline it decorates.
      // On failure the rail lists the loaded turns.
      void loadIndex()
        .catch(() => [])
        .then((turns) => setState("index", new Map(turns.toReversed())))
    }, railDelay)

    onCleanup(() => clearTimeout(timer))
  })

  return (
    <div
      ref={root}
      data-component="session-turn-navigator"
      aria-hidden="true"
      class="absolute start-0 top-[calc(var(--session-timeline-header-height,48px)+8px)] bottom-[calc(var(--session-timeline-inset,0px)+80px)] z-[50] flex w-8 flex-col justify-center pointer-events-none"
    >
      <Show when={state.engaged && (props.complete() || state.index)}>
        <TurnRail {...props} index={state.index} root={root!} />
      </Show>
    </div>
  )
}

function TurnRail(props: TurnNavigatorProps & { index?: Map<string, string>; root: HTMLDivElement }) {
  const sdk = useServerSDK()

  const [state, setState] = createStore<{
    hover?: string
    // The previewed turn, kept while the preview fades out.
    shown?: string
    open: boolean
    // Fetched replies by user message ID; null while loading or when there is no reply text.
    replies: Record<string, string | null>
  }>({ open: false, replies: {} })

  const loaded = createMemo(
    () =>
      new Map(props.messages().flatMap((message) => (message.type === "user" ? [[message.id, message] as const] : []))),
  )

  // Timeline order, as the server lists it. IDs from other clients do not sort chronologically, so neither the order
  // nor the reverted boundary may compare them. Streaming replaces the loaded messages on every delta, so the list keeps
  // its identity until the turns themselves change.
  const turns = createMemo(
    () => {
      const tail = [...loaded().keys()]
      // Turns paged in from beyond a capped index are older than all of it.
      const join = tail.findIndex((id) => props.index?.has(id))
      const ids = [...new Set([...tail.slice(0, Math.max(0, join)), ...(props.index?.keys() ?? []), ...tail])]
      const revert = props.revertMessageID()
      const reverted = revert ? ids.indexOf(revert) : -1

      return reverted === -1 ? ids : ids.slice(0, reverted)
    },
    [],
    {
      equals: (previous, next) => previous.length === next.length && previous.every((id, index) => id === next[index]),
    },
  )

  const abort = new AbortController()
  onCleanup(() => abort.abort())

  // The turn's latest reply is the newest assistant text between its prompt and the next turn.
  const loadReply = async (id: string) => {
    setState("replies", id, null)
    const list = turns()

    const page = await sdk.api.message.list(
      {
        sessionID: props.sessionID,
        limit: replyScanLimit,
        before: list[list.indexOf(id) + 1] ?? props.revertMessageID(),
      },
      { signal: abort.signal },
    )

    const end = page.data.findIndex((message) => message.type === "user")

    if (end !== -1 && page.data[end]!.id !== id) return

    const replies = (end === -1 ? page.data : page.data.slice(0, end)).filter(
      (message): message is SessionMessageAssistant => message.type === "assistant",
    )

    setState("replies", id, replyText(replies.toReversed()) ?? null)
  }

  createEffect(() => {
    const id = state.hover

    if (!id || loaded().has(id) || state.replies[id] !== undefined) return
    const timer = setTimeout(() => void loadReply(id).catch(() => undefined), replyHoverDelay)
    onCleanup(() => clearTimeout(timer))
  })

  const active = createSelector(props.visibleUserMessageIDs, (id: string, visible) => visible.has(id))
  const hovered = createSelector(() => state.hover)
  const hovering = createMemo(() => !!state.hover)

  // Only the first preview waits; moving along an engaged rail switches it immediately.
  createEffect(() => {
    if (!hovering()) {
      setState("open", false)

      return
    }

    const timer = setTimeout(() => setState("open", true), previewHoverDelay)
    onCleanup(() => clearTimeout(timer))
  })

  // A closed preview keeps its last content for the fade-out without following a streaming reply.
  const preview = createMemo((previous?: { prompt?: string; response?: string }) => {
    const id = state.shown

    if (!id || !state.open) return previous
    const message = loaded().get(id)

    return {
      prompt: message ? promptPreview(message) : props.index?.get(id),
      response: message ? replyText(props.assistantMessagesByParent().get(id) ?? []) : (state.replies[id] ?? undefined),
    }
  })

  let list: HTMLDivElement | undefined
  let card: HTMLDivElement | undefined
  // Each tick's element and the scale last written to it.
  const ticks = new Map<string, { element: HTMLElement; scale: number }>()
  // The pointer's clientY over the rail, and the rail's geometry from the last frame's read phase.
  let pointer: number | undefined

  const rail = { top: 0, height: 0, root: 0, rootHeight: 0 }

  // `position` follows the pointer in tick units and `wave` swells the ticks around it, so one pair drives every tick.
  const motion = {
    wave: Spring.fromDuration(0, { duration: 0.2, bounce: 0 }),
    position: Spring.fromDuration(0, { duration: 0.12, bounce: 0 }),
    top: Spring.fromDuration(0, { duration: 0.25, bounce: 0 }),
    opacity: Spring.fromDuration(0, { duration: 0.18, bounce: 0 }),
  }

  let frame: (() => void) | undefined

  // Reduced motion drops travel but keeps the preview's fade.
  const step = (spring: Spring, dt: number) =>
    spring === motion.opacity || !prefersReducedMotion() ? spring.step(dt) : spring.snap(spring.target).value

  const paint = (dt: number) => {
    const ids = turns()
    const pitch = rail.height / Math.max(1, ids.length)

    if (pointer !== undefined && pitch > 0) {
      const hit = railHit(pointer - rail.top, rail.height, ids.length)
      const id = ids[hit.index]
      const tick = rail.top - rail.root + (hit.index + 0.5) * pitch

      // Entering the rail starts the wave under the pointer rather than sweeping in from where it left.
      if (motion.wave.value === 0) motion.position.snap(hit.position)
      motion.position.set(hit.position)
      motion.wave.set(1)
      motion.top.set(Math.max(0, Math.min(rail.rootHeight - previewMaxHeight, tick - previewAnchor)))

      // Store writes re-render, so they wait until the frame's style writes are done.
      if (id && id !== state.hover) queueMicrotask(() => pointer !== undefined && setState({ hover: id, shown: id }))
    }

    const position = step(motion.position, dt)
    const wave = step(motion.wave, dt)

    ids.forEach((id, index) => {
      const distance = Math.abs(index - position) * pitch
      const swell = distance < waveRadius ? (wave * (1 + Math.cos((distance / waveRadius) * Math.PI))) / 2 : 0
      const rest = active(id) ? tickWidths.active : tickWidths.default
      const scale = (rest + (tickWidths.peak - rest) * swell) / tickWidths.peak
      const tick = ticks.get(id)

      if (!tick || tick.scale === scale) return
      tick.scale = scale
      tick.element.style.transform = `scaleX(${scale})`
    })

    motion.opacity.set(state.open ? 1 : 0)

    // A preview that opens from hidden appears in place; one already showing glides to the next turn.
    if (motion.opacity.value === 0) motion.top.snap(motion.top.target)
    const opacity = step(motion.opacity, dt)

    if (card) {
      card.style.transform = `translateY(${step(motion.top, dt)}px)`
      card.style.opacity = String(opacity)
      card.style.visibility = opacity === 0 ? "hidden" : "visible"
    }

    return Object.values(motion).some((spring) => !spring.resting)
  }

  const wake = () => {
    frame ??= frameLoop.addMeasured(
      () => {
        // Only the pointer needs geometry; reading it otherwise would force a layout on every streamed frame.
        if (!list || pointer === undefined) return
        const box = list.getBoundingClientRect()
        const root = props.root.getBoundingClientRect()
        rail.top = box.top
        rail.height = box.height
        rail.root = root.top
        rail.rootHeight = root.height
      },
      (dt) => {
        if (paint(dt)) return true
        frame = undefined

        return false
      },
    )
  }

  const leave = () => {
    pointer = undefined
    motion.wave.set(0)
    setState("hover", undefined)
    wake()
  }

  // Resting widths follow the visible turns, and the preview follows its open state.
  createEffect(() => {
    turns().forEach((id) => active(id))
    void state.open
    wake()
  })

  onCleanup(() => frame?.())

  return (
    <Show when={turns().length > 1}>
      <div
        class="flex max-h-full min-h-0 w-full cursor-pointer flex-col py-6 pointer-events-auto animate-in fade-in [animation-duration:180ms] [animation-timing-function:ease-out] motion-reduce:animate-none"
        onPointerMove={(event) => {
          pointer = event.clientY
          wake()
        }}
        onPointerLeave={leave}
        // Scrolling over the rail closes the preview; the next pointer move reopens it on the turn below the pointer.
        onWheel={leave}
        onClick={(event) => {
          if (!list) return
          const box = list.getBoundingClientRect()
          const ids = turns()
          const id = ids[railHit(event.clientY - box.top, box.height, ids.length).index]

          if (id) props.onSelect(id)
        }}
      >
        <div ref={list} class="flex min-h-0 flex-col">
          <For each={turns()}>
            {(id, index) => (
              <div
                data-turn={id}
                data-index={index()}
                // Active state wins so a clicked or visible turn stays active under the pointer. The hovered tick is
                // still the brightest: it lights at once and cools off as the pointer moves on.
                data-state={active(id) ? "active" : hovered(id) ? "hovered" : "default"}
                class="flex h-2.5 min-h-0 w-full shrink items-center ps-2.5 [--tick-color:var(--v2-background-bg-layer-04)] [--tick-opacity:1] [[data-color-scheme=dark]_&]:data-[state=default]:[--tick-opacity:0.7] data-[state=active]:[--tick-color:var(--v2-icon-icon-muted)]"
              >
                <span
                  ref={(element) => {
                    const scale = (active(id) ? tickWidths.active : tickWidths.default) / tickWidths.peak
                    element.style.transform = `scaleX(${scale})`
                    ticks.set(id, { element, scale })
                    onCleanup(() => ticks.delete(id))
                  }}
                  class="pointer-events-none block h-0.5 shrink-0 origin-left bg-(--tick-color) rtl:origin-right"
                  style={{
                    width: `${tickWidths.peak}px`,
                    opacity: hovered(id) ? 1 : "var(--tick-opacity)",
                    "background-color": hovered(id) ? "var(--v2-icon-icon-base)" : undefined,
                    transition: hovered(id) ? "none" : "background-color 180ms ease-out, opacity 180ms ease-out",
                  }}
                />
              </div>
            )}
          </For>
        </div>
      </div>
      <div
        ref={card}
        data-slot="session-turn-navigator-preview"
        class="pointer-events-none invisible absolute start-12 top-0 w-[384px] max-w-[calc(100cqw-4rem)] rounded-lg bg-v2-background-bg-base p-3 opacity-0"
        style={{ "box-shadow": "var(--v2-elevation-raised)" }}
      >
        <Show when={preview()}>
          {(item) => (
            <>
              <p
                dir="auto"
                class="line-clamp-4 break-words text-[13px] font-medium leading-text-base text-v2-text-text-base"
              >
                {item().prompt}
              </p>
              <Show when={item().response}>
                {(text) => (
                  <p
                    dir="auto"
                    class="mt-2 line-clamp-5 break-words text-[13px] leading-text-base text-v2-text-text-muted"
                  >
                    {text()}
                  </p>
                )}
              </Show>
            </>
          )}
        </Show>
      </div>
    </Show>
  )
}

function promptPreview(message: SessionMessageUser) {
  return previewText(readPromptPresentation(message.metadata)?.displayText ?? message.text)
}

function replyText(messages: SessionMessageAssistant[]) {
  const text = messages
    .flatMap((message) => message.content)
    .findLast((content) => content.type === "text" && content.text.trim())

  return text?.type === "text" ? previewText(text.text) : undefined
}

function previewText(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, previewLength)
}

/**
 * The tick nearest a pointer `offset` px down a rail of `count` evenly spaced ticks `height` px tall, and the pointer's
 * position in tick units (0 is the first tick's centre). Offsets beyond either end clamp to that end's tick.
 */
function railHit(offset: number, height: number, count: number) {
  const position = Math.min(count - 1, Math.max(0, (offset / height) * count - 0.5))

  return { index: Math.round(position), position }
}
