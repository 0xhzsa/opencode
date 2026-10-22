import { lazy, onCleanup, Show, Suspense } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Keybind } from "@opencode/ui/keybind"
import { Tooltip } from "@opencode/ui/tooltip"
import { Command, onIdle, Panel, Slot, usePanel, type MountedSession, type PanelTab, type Setup } from "../sdk"
import type Details from "./index"

const setup: Setup<typeof Details> = (ctx) => {
  const sessions = ctx.sessions
  const layout = ctx.layout
  const key = `${ctx.id}:main`

  const ExtensionsTab = lazy(() => import("./extensions"))
  const LocationMenu = lazy(() => import("./location-menu"))
  const LocationWorkspace = lazy(() => import("./location-workspace"))

  // Compile the tab while the app idles, so the first open renders at once.
  onCleanup(
    onIdle(() => {
      void ExtensionsTab.preload()
      void LocationMenu.preload()
      void LocationWorkspace.preload()
    }),
  )

  // Opens the extensions tab, or selects it when it is already open.
  const open = (session: MountedSession) => layout.open(key, session)

  ctx.add(Slot, {
    at: "session.header",
    order: 20,
    render: (input) => <ExtensionsButton session={input.session} active={input.active} onOpen={open} />,
  })

  ctx.add(Slot, {
    at: "session.location.menu",
    render: (input) => (
      <Suspense>
        <LocationMenu session={input.session} screen={input.screen} shown={input.shown} />
      </Suspense>
    ),
  })

  ctx.add(Slot, {
    at: "session.location.workspace",
    render: (input) => (
      <Suspense>
        <LocationWorkspace {...input} />
      </Suspense>
    ),
  })

  // One tab object for every session, so neither strip updates nor a session switch remount its trigger.
  const tab: PanelTab = {
    id: "main",
    get title() {
      return ctx.t("server")
    },
    closable: "compact",
  }

  const panel: Panel = {
    id: "main",
    region: "side",
    mobile: {
      get title() {
        return ctx.t("server")
      },
      order: 50,
      kind: "menu",
      icon: "window-analytics",
    },
    list: (input) => (input.open.includes("main") ? [tab] : []),
    closed: () => ({ icon: "window-analytics" }),
    render: (props) => {
      const frame = usePanel()

      return (
        <div class="relative flex-1 min-h-0 overflow-hidden" classList={{ "pt-2": frame.placement() !== "mobile" }}>
          <Suspense>
            <ExtensionsTab session={props.session} shown={frame.visible()} />
          </Suspense>
        </div>
      )
    },
  }

  // Offered for sessions of a project, subagents included.
  ctx.add(Panel, () => {
    const session = sessions.current()

    if (!session?.project) return

    return panel
  })

  function ExtensionsButton(props: {
    session: MountedSession
    active: boolean
    onOpen: (session: MountedSession) => void
  }) {
    const keybind = () => [...ctx.keybinds.keybind(`${ctx.id}.toggle`)]

    // Cached timelines remain mounted; only the visible one owns the command, which leaves with it.
    ctx.add(Command, (): Command | undefined =>
      props.active && props.session.project
        ? {
            // The id keeps the details popover's keybind, which the keybind migration names `details.toggle`.
            id: "toggle",
            title: ctx.t("command.extensions"),
            group: ctx.t("command.category.view"),
            section: "session",
            bind: "mod+shift+y",
            run: () => props.onOpen(props.session),
          }
        : undefined,
    )

    return (
      <Show when={props.session.project}>
        <Tooltip
          placement="bottom"
          value={
            <>
              {ctx.t("server")}
              <Show when={keybind().length > 0}>
                <Keybind keys={keybind()} variant="neutral" />
              </Show>
            </>
          }
        >
          <IconButton
            icon={<Icon name="window-analytics" />}
            variant="ghost-muted"
            size="large"
            state={layout.state(key, props.session) === "visible" ? "pressed" : undefined}
            aria-label={ctx.t("server")}
            onClick={() => props.onOpen(props.session)}
          />
        </Tooltip>
      </Show>
    )
  }
}

export default setup
