import { makeEventListener } from "@solid-primitives/event-listener"
import { useNavigate } from "@solidjs/router"
import { Schema } from "effect"
import { createEffect, createResource, For, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useDialog } from "@opencode/ui/context/dialog"
import { base64Encode } from "@opencode/util/encode"
import { useLanguage } from "@/runtime/i18n/language"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { formatServerError } from "@/runtime/server/errors"
import { useGlobal } from "@/runtime/server/runtime"
import { isExtensionTab, isRootTab } from "@/settings/route"
import { useSettingsSurface } from "@/settings/surface"
import { isEditableTarget, useCommand } from "@/shell/commands/command"
import { showToast } from "@/shell/notifications/toast"
import { sessionHref } from "@/shell/routes/session"
import { TourCard, TourPill, verdictPrompt, type TourStatus } from "./card"
import { loadManifest, TourVerdict, type TourStop } from "./manifest"
import { arrive, knobScope, type KnobScope, type TourApp } from "./setup"
import { selectorError, SpotlightRing } from "./spotlight"
import { motion, sprung } from "./spring"

const Corner = Schema.Literals(["top-left", "top-right", "bottom-left", "bottom-right"])

type Corner = typeof Corner.Type

const TourState = Persistence.struct({
  manifest: Schema.String,
  stop: Schema.Finite,
  corner: Corner,
  collapsed: Schema.Boolean,
  verdicts: Persistence.record(Persistence.optional(TourVerdict)),
})

/**
 * A review tour: a floater that walks through the stops of the manifest at `url`, setting the app up for each one, and
 * sends each verdict to the manifest's coordinator session as a queued prompt. Its keys are ⌥. and ⌥, for the next and
 * previous stop, and ⌥1–9 for a decision's options.
 */
export default function ReviewTour(props: { url: string; onEnd: () => void }) {
  const language = useLanguage()
  const navigate = useNavigate()
  const command = useCommand()
  const dialog = useDialog()
  const settings = useSettingsSurface()
  const servers = useServers()
  const global = useGlobal()
  const [manifest] = createResource(() => props.url, loadManifest)

  const [state, setState, , ready] = persisted(Persist.global("review-tour"), TourState, {
    manifest: "",
    stop: 0,
    corner: "bottom-right",
    collapsed: false,
    verdicts: {},
  })

  const [view, setView] = createStore<{
    closed: boolean
    editing: boolean
    /** A verdict is on its way; its controls wait. */
    sending: boolean
    /** What went wrong on this stop; cleared on leaving it. */
    problem?: TourStatus
    flash?: TourStatus
    selected: { [id: string]: number | undefined }
    rings: { key: number; selector: string; label: string; leaving: boolean }[]
  }>({ closed: false, editing: false, sending: false, selected: {}, rings: [] })

  const tour = () => (manifest.state === "ready" && ready() && state.manifest === props.url ? manifest() : undefined)
  const count = () => tour()?.stops.length ?? 0
  const index = () => Math.min(Math.max(0, state.stop), count() - 1)
  const stop = () => (view.closed ? undefined : tour()?.stops[index()])

  const healthy = () => servers.list.find((conn) => global.servers.health[ServerConnection.key(conn)]?.healthy)

  const app: TourApp = {
    navigate: (path) => navigate(path),
    serverSegment: () => {
      const conn = healthy()

      return conn && base64Encode(ServerConnection.key(conn))
    },
    sessionPath: (sessionID) => {
      const conn = healthy()

      return conn && sessionHref(ServerConnection.key(conn), sessionID)
    },
    settings: (tab) => {
      if (!isRootTab(tab) && !isExtensionTab(tab, settings.extensions.tabs())) return false
      settings.open(tab)

      return true
    },
    palette: () => command.show(),
    dialogOpen: () => !!dialog.active,
    closeDialog: () => dialog.close(),
  }

  // A different tour starts from its first stop.
  createEffect(() => {
    if (!ready() || state.manifest === props.url) return
    setState({ manifest: props.url, stop: 0, verdicts: {} })
  })

  createEffect(() => {
    if (manifest.state !== "errored") return
    showToast({
      variant: "error",
      title: language.t("tour.loadFailed", { error: formatServerError(manifest.error, language.t) }),
    })
  })

  let arrival: { knobs: KnobScope; signal: AbortSignal } | undefined
  let ringKey = 0

  createEffect(
    on(stop, (current) => {
      const invalid = current?.spotlight === undefined ? undefined : selectorError(current.spotlight)

      setView(
        produce((draft) => {
          draft.editing = false
          draft.problem = undefined
          draft.rings.forEach((ring) => (ring.leaving = true))

          if (current?.spotlight && !invalid)
            draft.rings.push({ key: ++ringKey, selector: current.spotlight, label: current.id, leaving: false })
        }),
      )

      if (invalid) problem(invalid)

      if (!current) return

      const controller = new AbortController()
      const knobs = knobScope()
      arrival = { knobs, signal: controller.signal }

      arrive(current, app, knobs, controller.signal)
        .then(() => {
          // A page that focuses its composer on arrival would keep the tour's keys; the palette's field is the point.
          const focused = document.activeElement

          if (current.palette === undefined && focused instanceof HTMLElement && isEditableTarget(focused))
            focused.blur()

          return showOption(current, knobs, controller.signal)
        })
        .catch((error) => controller.signal.aborted || problem(formatServerError(error, language.t)))

      onCleanup(() => {
        controller.abort()
        knobs.restore()
        arrival = undefined
      })
    }),
  )

  // A decision shows the option picked before, else whichever its knobs already hold.
  const showOption = async (current: TourStop, knobs: KnobScope, signal: AbortSignal) => {
    const options = current.options ?? []
    const verdict = state.verdicts[current.id]
    const picked = verdict?.kind === "pick" ? options.findIndex((option) => option.label === verdict.option) : -1
    const remembered = view.selected[current.id] ?? (picked === -1 ? undefined : picked)

    if (remembered !== undefined) return select(remembered)

    const held = await Promise.all(options.map((option) => option.knobs && knobs.holds(option.knobs, signal)))
    const holding = held.indexOf(true)

    if (holding !== -1 && !signal.aborted) setView("selected", current.id, holding)
  }

  const select = (option: number) => {
    const current = stop()
    const here = arrival
    const values = current?.options?.[option]?.knobs

    if (!current?.options?.[option] || !here) return
    setView("selected", current.id, option)

    if (values)
      here.knobs
        .apply(values, here.signal)
        .catch((error) => here.signal.aborted || problem(formatServerError(error, language.t)))
  }

  const problem = (error: string) =>
    setView("problem", { kind: "problem", text: language.t("tour.problem", { error }) })

  const go = (by: number) => {
    const next = index() + by

    if (next < 0 || next >= count()) return
    setState("stop", next)
  }

  let flashTimer: ReturnType<typeof setTimeout> | undefined

  const flash = (status: TourStatus) => {
    clearTimeout(flashTimer)
    setView("flash", status)
    flashTimer = setTimeout(() => setView("flash", undefined), 2400)
  }

  onCleanup(() => clearTimeout(flashTimer))

  const send = (verdict: TourVerdict) => {
    const current = stop()
    const coordinator = tour()?.coordinator

    if (!current || view.sending) return

    setView("editing", false)

    const record = (text: string) => {
      setState("verdicts", current.id, verdict)
      flash({ kind: "sent", text: `${current.id} · ${text}` })

      if (stop() === current) go(1)
    }

    if (!coordinator) return record(language.t("tour.recorded"))

    const conn = healthy()

    // A failure stays on its stop until it's left or sent again.
    const fail = (error: string) => setView("problem", { kind: "failed", text: language.t("tour.failed", { error }) })

    if (!conn) return fail(language.t("tour.noServer"))

    clearTimeout(flashTimer)
    setView({ sending: true, problem: undefined, flash: { kind: "sending", text: language.t("tour.sending") } })
    global
      .ensureServerCtx(conn)
      .sdk.api.session.prompt({ sessionID: coordinator, text: verdictPrompt(current.id, verdict), delivery: "queue" })
      .then(
        () => {
          setView("sending", false)
          record(language.t("tour.sent"))
        },
        (error) => {
          setView({ sending: false, flash: undefined })
          fail(formatServerError(error, language.t))
        },
      )
  }

  makeEventListener(
    window,
    "keydown",
    (event) => {
      // ⌥ types characters on macOS, so fields keep their keys; the floater's own buttons move from anywhere else.
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || !stop()) return

      if (isEditableTarget(event.target)) return

      const digit = Number(/^Digit([1-9])$/.exec(event.code)?.[1])

      const action =
        event.code === "Period"
          ? () => go(1)
          : event.code === "Comma"
            ? () => go(-1)
            : digit && stop()?.options
              ? () => select(digit - 1)
              : undefined

      if (!action) return
      event.preventDefault()
      event.stopImmediatePropagation()
      action()
    },
    { capture: true },
  )

  // The window title names the stop, so a screen recording's title says where it was.
  const title = document.title

  createEffect(() => {
    const current = stop()

    document.title = current ? `${current.id} · ${current.title}` : title
  })
  onCleanup(() => (document.title = title))

  return (
    <Portal>
      <For each={view.rings}>
        {(ring) => (
          <SpotlightRing
            selector={ring.selector}
            label={ring.label}
            leaving={ring.leaving}
            onGone={() => setView("rings", (rings) => rings.filter((item) => item.key !== ring.key))}
          />
        )}
      </For>
      <Show when={stop()}>
        {(current) => (
          <Floater
            corner={state.corner}
            collapsed={state.collapsed}
            onCorner={(corner) => setState("corner", corner)}
            onCollapsed={(collapsed) => setState("collapsed", collapsed)}
            card={(grab) => (
              <TourCard
                stop={current()}
                position={index() + 1}
                count={count()}
                verdict={state.verdicts[current().id]}
                selected={view.selected[current().id]}
                status={view.problem ?? view.flash}
                editing={view.editing}
                busy={view.sending}
                onEdit={(editing) => {
                  // A modal palette would keep the note field from taking focus.
                  if (editing && dialog.active) dialog.close()
                  setView("editing", editing)
                }}
                onPrevious={() => go(-1)}
                onNext={() => go(1)}
                onSelect={select}
                onVerdict={send}
                onCollapse={() => setState("collapsed", true)}
                onClose={() => {
                  setView("closed", true)
                  props.onEnd()
                }}
                onGrab={grab}
              />
            )}
            pill={(grab) => <TourPill stop={current()} position={index() + 1} count={count()} onGrab={grab} />}
          />
        )}
      </Show>
    </Portal>
  )
}

/**
 * The floater: docked to a corner, dragged 1:1 by its header or pill, and on release springing into the nearest
 * corner. Collapsing fades the card into a pill in the same corner.
 */
function Floater(props: {
  corner: Corner
  collapsed: boolean
  onCorner: (corner: Corner) => void
  onCollapsed: (collapsed: boolean) => void
  card: (grab: (event: PointerEvent) => void) => JSX.Element
  pill: (grab: (event: PointerEvent) => void) => JSX.Element
}) {
  let element!: HTMLDivElement
  let cardLayer!: HTMLDivElement
  let pillLayer!: HTMLDivElement
  const offset = { x: 0, y: 0 }

  const place = () => (element.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`)
  const x = sprung(0, { ...motion.calm, travel: true }, (value) => ((offset.x = value), place()))
  const y = sprung(0, { ...motion.calm, travel: true }, (value) => ((offset.y = value), place()))

  const paintOpen = (open: number) => {
    cardLayer.style.opacity = String(open)
    cardLayer.style.transform = `scale(${0.96 + 0.04 * open})`
    pillLayer.style.opacity = String(1 - open)
    pillLayer.style.transform = `scale(${0.96 + 0.04 * (1 - open)})`
  }

  const open = sprung(props.collapsed ? 0 : 1, motion.settle, paintOpen)

  // No animation on load: the first paint is the resting state.
  onMount(() => paintOpen(props.collapsed ? 0 : 1))
  createEffect(
    on(
      () => props.collapsed,
      (collapsed) => open.set(collapsed ? 0 : 1),
      { defer: true },
    ),
  )
  onCleanup(() => {
    x.dispose()
    y.dispose()
    open.dispose()
  })

  const grab = (event: PointerEvent) => {
    if (event.button !== 0) return

    const target = event.currentTarget

    if (!(target instanceof HTMLElement)) return

    const start = { x: event.clientX - offset.x, y: event.clientY - offset.y }
    let moved = false

    target.setPointerCapture(event.pointerId)

    const move = (next: PointerEvent) => {
      moved ||= Math.hypot(next.clientX - event.clientX, next.clientY - event.clientY) > 3

      if (!moved) return
      x.snap(next.clientX - start.x)
      y.snap(next.clientY - start.y)
    }

    const up = () => {
      target.removeEventListener("pointermove", move)
      target.removeEventListener("pointerup", up)
      target.removeEventListener("pointercancel", up)

      if (!moved) {
        if (props.collapsed) props.onCollapsed(false)

        return
      }

      // Re-anchor to the nearest corner where the floater is now, then spring the leftover offset away.
      const before = element.getBoundingClientRect()
      const corner = nearest(before)
      props.onCorner(corner)
      const anchored = element.getBoundingClientRect()
      x.snap(offset.x + before.left - anchored.left)
      y.snap(offset.y + before.top - anchored.top)
      x.set(0)
      y.set(0)
    }

    target.addEventListener("pointermove", move)
    target.addEventListener("pointerup", up)
    target.addEventListener("pointercancel", up)
  }

  const top = () => props.corner.startsWith("top")
  const left = () => props.corner.endsWith("left")

  return (
    <div
      ref={element}
      data-component="review-tour"
      data-corner={props.corner}
      class="pointer-events-none fixed z-[2147483000] grid"
      style={{
        top: top() ? "56px" : "auto",
        bottom: top() ? "auto" : "16px",
        left: left() ? "16px" : "auto",
        right: left() ? "auto" : "16px",
        "justify-items": left() ? "start" : "end",
        "align-items": top() ? "start" : "end",
      }}
    >
      <div
        ref={cardLayer}
        class="[grid-area:1/1]"
        classList={{ "pointer-events-auto": !props.collapsed }}
        style={{ "transform-origin": `${top() ? "top" : "bottom"} ${left() ? "left" : "right"}` }}
        inert={props.collapsed}
      >
        {props.card(grab)}
      </div>
      <div
        ref={pillLayer}
        class="[grid-area:1/1]"
        classList={{ "pointer-events-auto": props.collapsed }}
        style={{ "transform-origin": `${top() ? "top" : "bottom"} ${left() ? "left" : "right"}` }}
        inert={!props.collapsed}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") props.onCollapsed(false)
        }}
      >
        {props.pill(grab)}
      </div>
    </div>
  )
}

function nearest(rect: DOMRect): Corner {
  const vertical = rect.top + rect.height / 2 < innerHeight / 2 ? "top" : "bottom"
  const horizontal = rect.left + rect.width / 2 < innerWidth / 2 ? "left" : "right"

  return `${vertical}-${horizontal}`
}
