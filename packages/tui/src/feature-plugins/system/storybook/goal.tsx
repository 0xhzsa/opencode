import type { Plugin } from "@opencode/plugin/tui"
import type { SessionInfo } from "@opencode/client"
import type { SessionGoal } from "@opencode/schema/session-goal"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal } from "solid-js"
import { PromptFooter } from "../../prompt/footer"
import type { Story } from "./index"
import { StoryFooter } from "./footer"

const statuses: SessionGoal.Status[] = ["active", "paused", "complete"]
const reasons: Record<SessionGoal.Status, string | undefined> = {
  active: "The parseDate test still fails.",
  paused: "Stopped by the user",
  complete: "bun test reports 12 pass, 0 fail.",
}
const objectives = [
  "Make the test suite pass without skipping any tests",
  "Migrate every route in packages/server from the legacy router to HttpApi, keep the generated client in sync, and make sure the desktop app and the TUI still pass their end-to-end suites afterwards",
]

const initial: SessionGoal.State = {
  id: "fixture-goal",
  sessionID: "fixture-session",
  objective: objectives[0] ?? "",
  status: "active",
  reason: reasons.active,
  rounds: 3,
  maxRounds: 50,
  boot: "fixture",
  updatedAt: 0,
}

function GoalStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const [goal, setGoal] = createSignal<SessionGoal.State | undefined>(initial)
  const [commands, setCommands] = createSignal<string[]>([])
  const session = (): SessionInfo => {
    const current = goal()
    return {
      id: "fixture-session",
      projectID: "fixture",
      title: "Goal fixture",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
      location: { directory: "/fixture" },
      metadata: current ? { "opencode.goal": current } : {},
    }
  }
  // Goal actions change the fixture instead of reaching the server.
  const run = (text: string) => {
    setCommands((list) => [...list.slice(-2), `/goal ${text}`])
    setGoal((current) => {
      if (!current || text === "clear") return undefined
      if (text === "pause") return { ...current, status: "paused", reason: "Paused by the user" }
      if (text === "resume") return { ...current, status: "active", reason: undefined }
      return current
    })
  }
  const fixture: Plugin.Context = {
    ...props.context,
    client: {
      ...props.context.client,
      session: {
        ...props.context.client.session,
        command: async (input) => run(input.text),
      },
    },
    data: {
      ...props.context.data,
      shell: { ...props.context.data.shell, list: () => [] },
      session: {
        ...props.context.data.session,
        get: () => session(),
        family: () => ["fixture-session"],
        status: () => "idle",
        cost: () => 0,
        message: { ...props.context.data.session.message, list: () => [] },
      },
    },
  }
  const cycle = () =>
    setGoal((current) => {
      const status = statuses[(statuses.indexOf(current?.status ?? "complete") + 1) % statuses.length] ?? "active"
      return { ...(current ?? initial), status, reason: reasons[status] }
    })
  const lengthen = () =>
    setGoal((current) =>
      current
        ? { ...current, objective: objectives[(objectives.indexOf(current.objective) + 1) % objectives.length] ?? "" }
        : current,
    )

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
      { bind: "s", title: "Cycle goal status", group: "Storybook", run: cycle },
      { bind: "l", title: "Toggle a long objective", group: "Storybook", run: lengthen },
      { bind: "x", title: "Clear goal", group: "Storybook", run: () => setGoal(undefined) },
      {
        bind: "r",
        title: "Reset",
        group: "Storybook",
        run: () => {
          setGoal(initial)
          setCommands([])
        },
      },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background.base}>
      <box flexGrow={1} flexDirection="column" paddingTop={1} paddingLeft={2} paddingRight={2}>
        <text fg={theme.text.base}>Goal under the prompt</text>
        <text fg={theme.text.muted}>Click the goal to open the objective and its actions.</text>
        <box flexGrow={1} />
        <box flexDirection="row" justifyContent="space-between" gap={2} paddingLeft={1} paddingRight={1}>
          <PromptFooter context={fixture} sessionID="fixture-session" mode="normal" showDetails={true} />
        </box>
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / goal"
        details={[goal()?.status ?? "no goal"]}
        status={commands().join(" · ") || undefined}
        message="Actions update this fixture only"
        controls={[
          { shortcut: "s", label: "cycle status" },
          { shortcut: "l", label: "long objective" },
          { shortcut: "x", label: "clear" },
          { shortcut: "r", label: "reset" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const goalStory: Story = {
  id: "goal",
  title: "Goal status",
  render: (context) => <GoalStory context={context} />,
}
