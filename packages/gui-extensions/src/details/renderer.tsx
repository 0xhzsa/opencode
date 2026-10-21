import { createMemo, lazy, onCleanup, Show, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import { createKeyed, onIdle, Panel, Slot, Style, useDrawer, usePanel, type Setup } from "../sdk"
import type Details from "./index"
import { DetailsHeader, type DetailsMenus } from "./popover"

const setup: Setup<typeof Details> = (ctx) => {
  const sessions = ctx.sessions
  const changes = ctx.uses.changes

  const menus: DetailsMenus = new Set()

  const DetailsPanel = lazy(() =>
    Promise.all([import("./panel"), import("./details.css?inline")]).then(([panel, css]) => {
      ctx.add(Style, css.default)

      return panel
    }),
  )

  // Compile the panel while the app idles, so the first open renders at once.
  onCleanup(onIdle(() => void DetailsPanel.preload()))

  ctx.add(Slot, {
    at: "session.header",
    order: 20,
    render: (input) => (
      <DetailsHeader
        menus={menus}
        session={input.session}
        screen={input.screen}
        active={input.active}
        panel={DetailsPanel}
      />
    ),
  })

  // The narrow-screen details drawer, offered for sessions of a project, subagents included.
  const panel: Panel = {
    id: "main",
    region: "side",
    mobile: {
      get title() {
        return ctx.t("title")
      },
      order: 50,
      kind: "drawer",
      icon: "info",
    },
    list: () => [],
    render: (props) => {
      const frame = usePanel()
      const drawer = useDrawer()
      const [store, setStore] = createStore({ dismissed: false })

      // Review is optional: the changes row offers it only while the review extension is active.
      const review = createMemo(() => {
        const live = changes()

        if (live.status !== "active") return

        return {
          details: () => live.value.details(props.session),
          open: () => {
            drawer?.close()
            live.value.open(props.session)
          },
        }
      })

      // The changes row loads the session directory's changes only while the drawer shows.
      createKeyed(changes, (service) =>
        createKeyed(frame.visible, () => onCleanup(service.watch(props.screen, "details"))),
      )

      return (
        <Show when={props.session.project}>
          {(project) => (
            <Suspense>
              <DetailsPanel
                mobile
                shown={frame.visible()}
                session={props.session}
                project={project()}
                diffs={project().vcs ? review()?.details() : []}
                moveDismissed={store.dismissed}
                onMoveDismiss={() => setStore("dismissed", true)}
                onReview={review()?.open}
              />
            </Suspense>
          )}
        </Show>
      )
    },
  }

  ctx.add(Panel, () => {
    const session = sessions.current()

    if (!session?.project) return

    return panel
  })
}

export default setup
