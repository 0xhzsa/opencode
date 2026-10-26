import type { Plugin } from "@opencode/plugin/tui"
import { SessionGoal } from "@opencode/schema/session-goal"
import { createMemo, createSignal, Show } from "solid-js"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"
import { DialogFooter, DialogHeader, DialogLayout, type DialogFooterAction } from "../../ui/dialog"

/** The goal `/goal` set on this Session, read from its metadata. */
export function sessionGoal(context: Plugin.Context, sessionID: string) {
  const session = context.data.session.get(sessionID)
  return session ? SessionGoal.fromMetadata(session.id, session.metadata) : undefined
}

function goalColor(theme: Plugin.Context["theme"], goal: SessionGoal.State) {
  if (goal.status === "paused") return theme.text.feedback.warning.base
  if (goal.status === "complete") return theme.text.feedback.success.base
  return theme.text.muted
}

export function goalLabel(goal: SessionGoal.State) {
  if (goal.status === "paused") return "goal paused"
  if (goal.status === "complete") return "goal met"
  return "goal"
}

/**
 * The goal under the prompt, beside the other session status. Its continuations are hidden from the timeline, so this
 * is where a running goal shows; the objective itself is in the dialog it opens.
 */
export function GoalStatus(props: { context: Plugin.Context; sessionID: string }) {
  const [hovered, setHovered] = createSignal(false)
  const goal = createMemo(() => sessionGoal(props.context, props.sessionID))
  const color = (current: SessionGoal.State) =>
    hovered() ? props.context.theme.text.base : goalColor(props.context.theme, current)

  return (
    <Show when={goal()}>
      {(current) => (
        <box
          flexShrink={0}
          onMouseOver={() => setHovered(true)}
          onMouseOut={() => setHovered(false)}
          onMouseUp={() => showGoal(props.context, props.sessionID)}
        >
          <text fg={color(current())} wrapMode="none">
            ◎ {goalLabel(current())}
          </text>
        </box>
      )}
    </Show>
  )
}

/** Opens the goal dialog for a Session, or explains how to start one. */
export function showGoal(context: Plugin.Context, sessionID: string) {
  if (!sessionGoal(context, sessionID)) {
    context.ui.toast.show({ message: "No goal is set. Start one with /goal <objective>.", variant: "info" })
    return
  }
  context.ui.dialog.show(() => <GoalDialog context={context} sessionID={sessionID} />)
}

function GoalDialog(props: { context: Plugin.Context; sessionID: string }) {
  const theme = useTheme().surface("dialog")
  const goal = createMemo(() => sessionGoal(props.context, props.sessionID))
  const run = (text: "pause" | "resume" | "clear") => {
    if (text === "clear") props.context.ui.dialog.clear()
    void props.context.client.session.command({ sessionID: props.sessionID, name: "goal", text }).catch((error) =>
      props.context.ui.toast.show({
        title: "Failed to update the goal",
        message: error instanceof Error ? error.message : String(error),
        variant: "error",
      }),
    )
  }
  const actions = createMemo((): DialogFooterAction[] => {
    const current = goal()
    if (!current) return []
    return [
      ...(current.status === "active" ? [{ title: "pause", key: "p", onTrigger: () => run("pause") }] : []),
      ...(current.status === "paused" ? [{ title: "resume", key: "r", onTrigger: () => run("resume") }] : []),
      { title: "clear", key: "x", onTrigger: () => run("clear") },
    ]
  })

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "p",
        title: "Pause goal",
        group: "Dialog",
        enabled: goal()?.status === "active",
        run: () => run("pause"),
      },
      {
        bind: "r",
        title: "Resume goal",
        group: "Dialog",
        enabled: goal()?.status === "paused",
        run: () => run("resume"),
      },
      { bind: "x", title: "Clear goal", group: "Dialog", enabled: goal() !== undefined, run: () => run("clear") },
    ],
  }))

  return (
    <Show when={goal()}>
      {(current) => (
        <DialogLayout
          header={<DialogHeader title="Goal" />}
          footer={{ actions: { primary: actions() } }}
          legacyFooter={<DialogFooter actions={{ primary: actions() }} />}
        >
          <box gap={1}>
            <text fg={theme.text.base}>{current().objective}</text>
            <box>
              <text fg={goalColor(theme, current())} wrapMode="none">
                ◎ {current().status === "active" ? "Active" : current().status === "paused" ? "Paused" : "Met"}
              </text>
              <Show when={current().reason}>{(reason) => <text fg={theme.text.muted}>{reason()}</text>}</Show>
            </box>
          </box>
        </DialogLayout>
      )}
    </Show>
  )
}
