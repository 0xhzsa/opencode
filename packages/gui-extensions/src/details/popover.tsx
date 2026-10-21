import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Keybind } from "@opencode/ui/keybind"
import { Menu } from "@opencode/ui/menu"
import { Tooltip } from "@opencode/ui/tooltip"
import { createMemo, onCleanup, Show, Suspense, type Component, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Command, createKeyed, createVisitState, useExtension, type MountedSession, type SessionScreen } from "../sdk"
import type Details from "./index"
import type { DetailsPanelProps } from "./panel"

/** Every mounted details menu, so a shortcut finds the one on screen. */
export type DetailsMenus = Set<{ trigger: () => HTMLButtonElement | undefined; toggle: () => void }>

/** The session details menu of one timeline header. Cached timelines each keep their own. */
export function DetailsHeader(props: {
  menus: DetailsMenus
  session: MountedSession
  screen: SessionScreen
  active: boolean
  panel: Component<DetailsPanelProps>
}) {
  const changes = useExtension<typeof Details>().uses.changes
  const Panel = props.panel
  // Cached timelines stay mounted while hidden; routing away from the session closes its details.
  const [open, setOpen] = createVisitState(false)
  const [store, setStore] = createStore({ dismissed: false })
  const project = createMemo(() => props.session.project)

  // Review is optional: the changes row offers it only while the review extension is active.
  const review = createMemo(() => {
    const live = changes()

    if (live.status !== "active") return

    return {
      details: () => live.value.details(props.session),
      open: () => {
        setOpen(false)
        live.value.open(props.session)
      },
    }
  })

  // The changes row loads the session directory's changes only while the details show.
  createKeyed(changes, (service) =>
    createKeyed(
      () => open() && props.screen,
      (screen) => onCleanup(service.watch(screen, "details")),
    ),
  )

  return (
    <Show when={project()}>
      {(project) => (
        <DetailsPopover menus={props.menus} active={props.active} open={open()} onOpenChange={setOpen}>
          <Suspense>
            <Panel
              menu
              session={props.session}
              shown={open()}
              project={project()}
              diffs={project().vcs ? review()?.details() : []}
              moveDismissed={store.dismissed}
              onMoveDismiss={() => setStore("dismissed", true)}
              onReview={review()?.open}
            />
          </Suspense>
        </DetailsPopover>
      )}
    </Show>
  )
}

function DetailsPopover(
  props: ParentProps<{ menus: DetailsMenus; active: boolean; open: boolean; onOpenChange: (open: boolean) => void }>,
) {
  const ctx = useExtension()
  const keybinds = ctx.keybinds

  // Cached timelines remain mounted; only the visible details own the command. It leaves with this component.
  // A shortcut opens the menu without its trigger, so the trigger is named as the anchor.
  let trigger: HTMLButtonElement | undefined
  const self = { trigger: () => trigger, toggle: () => props.onOpenChange(!props.open) }
  props.menus.add(self)
  onCleanup(() => props.menus.delete(self))

  ctx.add(Command, (): Command | undefined =>
    props.active
      ? {
          id: "toggle",
          title: ctx.t("command.toggle"),
          group: ctx.t("command.category.view"),
          section: "session",
          bind: "mod+shift+y",
          // A detached timeline can stay active, so the shortcut toggles the menu whose trigger is on screen.
          run: () => [...props.menus].find((menu) => menu.trigger()?.isConnected)?.toggle(),
        }
      : undefined,
  )

  const keybind = () => [...keybinds.keybind(`${ctx.id}.toggle`)]

  return (
    <Menu
      placement="bottom-end"
      gutter={4}
      modal={false}
      open={props.open}
      onOpenChange={props.onOpenChange}
      getAnchorRect={() => trigger?.getBoundingClientRect()}
    >
      <Tooltip
        placement="bottom"
        value={
          <>
            {ctx.t("tooltip")}
            <Show when={keybind().length > 0}>
              <Keybind keys={keybind()} variant="neutral" />
            </Show>
          </>
        }
      >
        <Menu.Trigger
          ref={trigger}
          as={IconButton}
          icon={<Icon name="outline-dots" />}
          variant="ghost-muted"
          size="large"
          state={props.open ? "pressed" : undefined}
          aria-label={ctx.t("title")}
        />
      </Tooltip>
      <Menu.Portal>
        <Menu.Content class="w-[280px]" aria-label={ctx.t("title")}>
          {props.children}
        </Menu.Content>
      </Menu.Portal>
    </Menu>
  )
}
