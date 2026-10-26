import type { SessionMessageInfo } from "@opencode/client/promise"
import type { SessionDocument } from "@opencode/session-ui/document"
import type { SessionGoal } from "@opencode/schema/session-goal"
import { CURRENT_SESSION_ID, STORY_MODEL, STORY_TIME, editThenTestDocument } from "@opencode/session-ui/storybook"
import { timelinePresets } from "@opencode/session-ui/timeline/detail"
import { createEffect, createMemo, on, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { SessionPreview } from "@/session/story-model"
import type { SessionActivityItem } from "./activity-chips"
import type { GoalAction } from "./goal-pill"

const timelineDetail = timelinePresets[2].value

const reasons: Record<SessionGoal.Status, string> = {
  active: "The parseDate test still fails.",
  paused: "Stopped by the user",
  complete: "bun test reports 12 pass, 0 fail.",
}

const activity = {
  subagents: [
    {
      key: "ses_child_audit",
      type: "subagent",
      label: "Audit the date parser",
      agent: "explore",
      sessionID: "ses_child_audit",
      target: "ses_child_audit",
      started: Date.now() - 42_000,
    },
  ],
  shells: [],
} satisfies { subagents: SessionActivityItem[]; shells: SessionActivityItem[] }

const notice = (id: string, description: string, offset: number): SessionMessageInfo => ({
  id,
  type: "synthetic",
  text: description,
  description,
  metadata: { source: "goal", goalID: "goal_story" },
  time: { created: STORY_TIME + offset },
})

const assistant = (id: string, text: string, offset: number): SessionMessageInfo => ({
  id,
  type: "assistant",
  agent: "build",
  model: STORY_MODEL,
  content: [{ type: "text", text }],
  time: { created: STORY_TIME + offset, completed: STORY_TIME + offset + 1_000 },
})

function document(working: boolean): SessionDocument {
  const messages: SessionMessageInfo[] = [
    ...editThenTestDocument.messages,
    notice("msg_goal_kickoff", "Goal: Make the test suite pass", 300_000),
    assistant("msg_goal_first", "I ran `bun test`: 11 pass, 1 fails in `parseDate`.", 301_000),
    assistant("msg_goal_second", "Fixed `parseDate` to keep the offset. `bun test`: 12 pass, 0 fail.", 304_000),
  ]

  return { sessionID: CURRENT_SESSION_ID, messages, status: { type: working ? "busy" : "idle" }, diffs: [] }
}

type PreviewArgs = { status: SessionGoal.Status; open: boolean; activity: boolean }

function Preview(props: PreviewArgs) {
  // Actions change this fixture instead of reaching a server.
  const [goal, setGoal] = createStore<{ state: SessionGoal.State | undefined }>({ state: undefined })

  const reset = () =>
    setGoal("state", {
      id: "goal_story",
      sessionID: CURRENT_SESSION_ID,
      objective: "Make the test suite pass without skipping any tests",
      status: props.status,
      reason: reasons[props.status],
      rounds: 1,
      maxRounds: 50,
      boot: "story",
      updatedAt: STORY_TIME,
    })

  createEffect(on(() => props.status, reset))

  const act = (action: GoalAction) => {
    const current = goal.state

    if (!current || action === "clear") return setGoal("state", undefined)

    if (action === "pause") return setGoal("state", { ...current, status: "paused", reason: "Paused by the user" })
    setGoal("state", { ...current, status: "active", reason: undefined })
  }

  const value = createMemo(() => document(goal.state?.status === "active"))

  onMount(() =>
    setTimeout(() => {
      const timeline = window.document.querySelector('[data-slot="story-timeline"]')
      timeline?.scrollTo({ top: timeline.scrollHeight })
    }, 150),
  )

  return (
    <SessionPreview
      title="Make the test suite pass"
      description="opencode · goal pill"
      document={value()}
      timelineDetail={timelineDetail}
      activity={props.activity ? activity : undefined}
      goal={goal.state ? { state: goal.state, open: props.open, onAction: act } : undefined}
    />
  )
}

export default {
  title: "OpenCode/Session/Goal pill",
  id: "session-goal-pill",
  render: (args: PreviewArgs) => <Preview {...args} />,
  args: { status: "active", open: false, activity: false },
  argTypes: {
    status: { control: { type: "select" }, options: ["active", "paused", "complete"] },
    open: { control: { type: "boolean" } },
    activity: { control: { type: "boolean" } },
  },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The Session's /goal as a capsule in the composer lane: its status, opening a popover with the objective, the last reason and the actions that apply.",
      },
    },
  },
}

export const Active = {}

export const Open = { args: { open: true } }

export const Paused = { args: { status: "paused" } }

export const Met = { args: { status: "complete" } }

export const WithActivity = { args: { activity: true } }
