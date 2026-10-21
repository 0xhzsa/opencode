import type { SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client/promise"
import type { SessionDocument } from "@opencode/session-ui/document"
import {
  CURRENT_SESSION_ID,
  STORY_MODEL,
  STORY_TIME,
  editThenTestDocument,
  largeCompletedDocument,
} from "@opencode/session-ui/storybook"
import { timelinePresets } from "@opencode/session-ui/timeline/detail"
import { createMemo, For, onCleanup, onMount, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { SessionPreview } from "@/session/story-model"
import { SettingsProvider } from "@/settings/model"
import { SessionActivityChips, type SessionActivityItem } from "./activity-chips"

// The app's default timeline preset.
const timelineDetail = timelinePresets[2].value

// Ages in milliseconds, so the panel shows seconds, minutes and an hour-long run side by side.
const subagents = [
  { id: "ses_child_scroll", agent: "alpha", description: "Investigate Linux scroll jacking", age: 12_000 },
  { id: "ses_child_audit", agent: "beta", description: "Audit the timeline projection", age: 65_000 },
  { id: "ses_child_search", agent: "beta", description: "Search for shell metadata", age: 3_000 },
]

const shells = [
  { id: "shl_dev", command: "bun run dev -- --port 4444", age: 3_720_000 },
  { id: "shl_test", command: "bun test --watch src/session", age: 341_000 },
]

const subagentItem = (index: number): SessionActivityItem => {
  const value = subagents[index % subagents.length]

  return {
    key: `${value.id}_${index}`,
    type: "subagent",
    label: value.description,
    agent: value.agent,
    sessionID: value.id,
    target: value.id,
    started: Date.now() - value.age,
  }
}

const shellItem = (index: number): SessionActivityItem => ({
  key: `${shells[index % shells.length].id}_${index}`,
  type: "shell",
  label: shells[index % shells.length].command,
  target: shells[index % shells.length].id,
  started: Date.now() - shells[index % shells.length].age,
})

// The timeline follows new work at the bottom, like a pinned session.
// Rows measure after the first frame, so wait past it.
const pin = (behavior: ScrollBehavior) =>
  setTimeout(() => {
    const timeline = document.querySelector('[data-slot="story-timeline"]')

    timeline?.scrollTo({ top: timeline.scrollHeight, behavior })
  }, 150)

const preview = (stage: number, subagentCount: number, shellCount: number) => () => {
  const value = liveDocument(stages[stage])

  onMount(() => pin("auto"))

  return (
    <SessionPreview
      title="Run background work"
      description="opencode · activity chips"
      document={value}
      timelineDetail={timelineDetail}
      activity={{
        subagents: Array.from({ length: subagentCount }, (_, index) => subagentItem(index)),
        shells: Array.from({ length: shellCount }, (_, index) => shellItem(index)),
      }}
    />
  )
}

// Each stage lists the work still running; finished work stays in the timeline as completed calls.
const stages = [
  { started: 0, finished: 0, shells: 0, finishedShells: 0 },
  { started: 1, finished: 0, shells: 0, finishedShells: 0 },
  { started: 2, finished: 0, shells: 0, finishedShells: 0 },
  { started: 2, finished: 0, shells: 1, finishedShells: 0 },
  { started: 2, finished: 0, shells: 2, finishedShells: 0 },
  { started: 2, finished: 1, shells: 2, finishedShells: 0 },
  { started: 2, finished: 2, shells: 2, finishedShells: 0 },
  { started: 2, finished: 2, shells: 2, finishedShells: 1 },
  { started: 2, finished: 2, shells: 2, finishedShells: 2 },
]

type Stage = (typeof stages)[number]

function liveDocument(stage: Stage): SessionDocument {
  const done = stage.finished === stage.started && stage.finishedShells === stage.shells && stage.started > 0

  const tools = [
    ...subagents.slice(0, stage.started).map(
      (value, index): SessionMessageAssistantTool => ({
        type: "tool",
        id: `tool_${value.id}`,
        name: "subagent",
        state:
          index < stage.finished
            ? {
                status: "completed",
                input: { agent: value.agent, description: value.description, prompt: value.description },
                content: [{ type: "text", text: "No issues found." }],
                metadata: { sessionID: value.id, status: "completed" },
              }
            : {
                status: "running",
                input: { agent: value.agent, description: value.description, prompt: value.description },
                metadata: { sessionID: value.id },
              },
        time: { created: STORY_TIME + 301_000 + index * 1_000, ran: STORY_TIME + 301_100 + index * 1_000 },
      }),
    ),
    ...shells.slice(0, stage.shells).map(
      (value, index): SessionMessageAssistantTool => ({
        type: "tool",
        id: `tool_${value.id}`,
        name: "shell",
        state: {
          status: "completed",
          input: { command: value.command, description: value.command },
          content: [{ type: "text", text: index === 0 ? "Local: http://localhost:4444/" : "Watching src/session" }],
          metadata: { shellID: value.id, status: index < stage.finishedShells ? "exited" : "running" },
        },
        time: { created: STORY_TIME + 304_000 + index * 1_000, ran: STORY_TIME + 304_100 + index * 1_000 },
      }),
    ),
  ]

  const messages: SessionMessageInfo[] = [
    ...editThenTestDocument.messages,
    ...largeCompletedDocument.messages.slice(-8),
    {
      id: "msg_user_activity",
      type: "user",
      text: "Audit the activity chips and keep the dev server and tests running while you work.",
      time: { created: STORY_TIME + 300_000 },
      metadata: { agent: "build", model: STORY_MODEL },
    },
    {
      id: "msg_assistant_activity",
      type: "assistant",
      agent: "build",
      model: STORY_MODEL,
      content: [
        {
          type: "text",
          text: "I'll delegate the audit to subagents and keep the dev server and tests running in the background.",
        },
        ...tools,
        ...(done
          ? [{ type: "text" as const, text: "Both audits passed and the background commands have exited." }]
          : []),
      ],
      time: { created: STORY_TIME + 300_500, completed: done ? STORY_TIME + 310_000 : undefined },
    },
  ]

  return { sessionID: CURRENT_SESSION_ID, messages, status: done ? { type: "idle" } : { type: "busy" }, diffs: [] }
}

// Scripted with `activity-story-stage` events on `document` so a recording can step through the work.
function LiveActivity() {
  const [story, setStory] = createStore({ stage: 0 })
  const stage = createMemo(() => stages[story.stage])
  const value = createMemo(() => liveDocument(stage()))

  onMount(() => {
    const step = (event: Event) => {
      if (!(event instanceof CustomEvent)) return

      setStory("stage", Number(event.detail))
      pin("smooth")
    }

    document.addEventListener("activity-story-stage", step)
    onCleanup(() => document.removeEventListener("activity-story-stage", step))
    pin("auto")
  })

  return (
    <SessionPreview
      title="Audit the activity chips"
      description="opencode · activity chips"
      document={value()}
      timelineDetail={timelineDetail}
      activity={{
        subagents: subagents
          .slice(stage().finished, stage().started)
          .map((_, index) => subagentItem(index + stage().finished)),
        shells: shells
          .slice(stage().finishedShells, stage().shells)
          .map((_, index) => shellItem(index + stage().finishedShells)),
        onOpen: (item) => {
          // The app opens the shell's tool call, or the group holding it, and centers it in the timeline.
          const part = document.querySelector(
            `[data-slot="story-timeline"] [data-timeline-part-ids*="tool_${item.target}"]`,
          )

          const trigger = part?.querySelector<HTMLElement>('[data-slot="collapsible-trigger"][aria-expanded="false"]')

          trigger?.click()
          requestAnimationFrame(() => part?.scrollIntoView({ block: "center", behavior: "smooth" }))
        },
      }}
    />
  )
}

export default {
  title: "OpenCode/Session/Activity chips",
  id: "session-activity-chips",
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Running subagents and background shells in one capsule above the production Composer. It opens a menu of the work.",
      },
    },
  },
}

export const NoActivity = { render: preview(0, 0, 0) }

export const OneSubagent = { render: preview(1, 1, 0) }

export const TwoSubagents = { render: preview(2, 2, 0) }

export const OneShell = { render: preview(7, 0, 1) }

export const SubagentsAndShells = { render: preview(4, 2, 2) }

export const ManySubagents = { render: preview(4, 12, 2) }

export const Live = { render: () => <LiveActivity /> }

const variants = [
  { id: "today", label: "a · Today" },
  { id: "capsule", label: "b · Capsule" },
  { id: "orb", label: "c · Capsule + JS orb" },
  { id: "css-orb", label: "d · Capsule + CSS orb" },
] as const

const counts = [
  { label: "1", subagents: 1, shells: 0 },
  { label: "3", subagents: 3, shells: 0 },
  { label: "12", subagents: 12, shells: 0 },
  { label: "3 + 2 shells", subagents: 3, shells: 2 },
]

// One chip resting where the composer would be: the capsule floats out of flow above its anchor.
function Chip(props: { variant: (typeof variants)[number]["id"]; subagents: number; shells: number }) {
  return (
    <div class="relative h-14">
      <div class="absolute inset-x-0 bottom-0">
        <div class="relative">
          <SessionActivityChips
            variant={props.variant}
            subagents={Array.from({ length: props.subagents }, (_, index) => subagentItem(index))}
            shells={Array.from({ length: props.shells }, (_, index) => shellItem(index))}
            onOpen={() => {}}
            onStop={() => {}}
          />
        </div>
      </div>
    </div>
  )
}

function Schemes(props: { children: (scheme: "light" | "dark") => JSX.Element }) {
  return (
    <SettingsProvider>
      <div class="flex min-h-screen">
        <For each={["light", "dark"] as const}>
          {(scheme) => (
            <div
              data-color-scheme={scheme}
              data-slot="capsule-scheme"
              class="flex-1 bg-v2-background-bg-base p-8 text-v2-text-text-base"
              style={{ background: "var(--v2-background-bg-base)", color: "var(--v2-text-text-base)" }}
            >
              {props.children(scheme)}
            </div>
          )}
        </For>
      </div>
    </SettingsProvider>
  )
}

// The capsule decision: today's chip, capsule, JS orb and CSS orb, at 1, 3 and 12 running.
export const CapsuleOptions = {
  render: () => (
    <Schemes>
      {(scheme) => (
        <div
          class="grid grid-cols-[140px_130px_130px_140px_210px] gap-x-4 text-[12px]"
          style={{ color: "var(--v2-text-text-muted)" }}
        >
          <div class="pb-2" style={{ color: "var(--v2-text-text-base)" }}>
            {scheme === "light" ? "Light" : "Dark"}
          </div>
          <For each={counts}>{(count) => <div class="pb-2">{count.label}</div>}</For>
          <For each={variants}>
            {(variant) => (
              <>
                <div class="flex h-14 items-end pb-[16px]">{variant.label}</div>
                <For each={counts}>
                  {(count) => <Chip variant={variant.id} subagents={count.subagents} shells={count.shells} />}
                </For>
              </>
            )}
          </For>
        </div>
      )}
    </Schemes>
  ),
}

// All capsule options at 4×, animating in real time, for the motion clip.
export const CapsuleMotion = {
  render: () => (
    <Schemes>
      {() => (
        <div class="flex flex-col gap-6 text-[12px]" style={{ color: "var(--v2-text-text-muted)" }}>
          <For each={variants.slice(1)}>
            {(variant) => (
              <div>
                <div>{variant.label}</div>
                <div style={{ zoom: 4 }} class="w-[150px]">
                  <Chip variant={variant.id} subagents={3} shells={0} />
                </div>
              </div>
            )}
          </For>
        </div>
      )}
    </Schemes>
  ),
}
