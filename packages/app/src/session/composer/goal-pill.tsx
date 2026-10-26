import { Popover } from "@kobalte/core/popover"
import type { SessionGoal } from "@opencode/schema/session-goal"
import { Button } from "@opencode/ui/button"
import { createStore } from "solid-js/store"
import { Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useComposerLaneAlignment } from "./composer-lane"
import "./goal-pill.css"

export type GoalAction = "pause" | "resume" | "clear"

// The Session's `/goal` as a capsule in the composer lane: just its status, opening a popover with the objective, the
// last reason and the actions that apply.
export function SessionGoalPill(props: {
  goal: SessionGoal.State
  onAction: (action: GoalAction) => void
  defaultOpen?: boolean
}) {
  const language = useLanguage()
  const alignment = useComposerLaneAlignment()
  const [state, setState] = createStore({ open: props.defaultOpen ?? false })
  const placement = () => (({ center: "top", start: "top-start", end: "top-end" }) as const)[alignment()]

  const label = () => {
    if (props.goal.status === "paused") return language.t("session.goal.paused")

    if (props.goal.status === "complete") return language.t("session.goal.met")

    return language.t("session.goal.title")
  }

  const status = () => {
    if (props.goal.status === "paused") return language.t("session.goal.status.paused")

    if (props.goal.status === "complete") return language.t("session.goal.status.met")

    return language.t("session.goal.status.active")
  }

  const act = (action: GoalAction) => {
    if (action === "clear") setState("open", false)
    props.onAction(action)
  }

  return (
    <div
      data-component="session-goal-pill"
      class="flex min-w-0 shrink"
      classList={{ "-order-2": alignment() === "end", "order-2": alignment() !== "end" }}
    >
      <Popover open={state.open} onOpenChange={(open) => setState("open", open)} placement={placement()} gutter={8}>
        <Popover.Trigger
          as="button"
          type="button"
          data-slot="session-goal-pill"
          data-status={props.goal.status}
          class="pointer-events-auto flex h-7 min-w-0 max-w-full items-center gap-2 rounded-[12px] border-[0.5px] border-v2-border-border-muted bg-v2-background-bg-base ps-2.5 pe-2.5 text-[13px] font-[440] leading-text-compact tracking-[-0.04px] whitespace-nowrap text-v2-text-text-base shadow-[var(--v2-elevation-raised)] outline-none"
        >
          <GoalGlyph status={props.goal.status} />
          <span data-slot="session-goal-label" class="shrink-0 tabular-nums">
            {label()}
          </span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            data-slot="session-goal-panel"
            aria-label={language.t("session.goal.title")}
            class="outline-none"
          >
            <div class="flex items-center gap-2 px-3 pb-1.5">
              <span class="flex-1 text-[11px] font-[530] uppercase leading-[var(--line-height-tight)] tracking-[0.05px] text-v2-text-text-muted">
                {language.t("session.goal.title")}
              </span>
              <span
                data-slot="session-goal-status"
                data-status={props.goal.status}
                class="text-[11px] tabular-nums leading-[var(--line-height-tight)]"
              >
                {status()}
              </span>
            </div>
            <p
              dir="auto"
              data-slot="session-goal-objective"
              class="m-0 max-h-[160px] overflow-y-auto px-3 text-[13px] leading-[var(--line-height-compact)] text-v2-text-text-base whitespace-pre-wrap"
              data-scrollable
            >
              {props.goal.objective}
            </p>
            <Show when={props.goal.reason}>
              {(reason) => (
                <p
                  dir="auto"
                  data-slot="session-goal-reason"
                  class="m-0 px-3 pt-1.5 text-[12px] leading-[var(--line-height-compact)] text-v2-text-text-muted"
                >
                  {reason()}
                </p>
              )}
            </Show>
            <div class="flex justify-end gap-1 px-2 pt-2.5 pb-1">
              <Show when={props.goal.status === "active"}>
                <Button data-action="session-goal-pause" size="small" variant="ghost" onClick={() => act("pause")}>
                  {language.t("session.goal.pause")}
                </Button>
              </Show>
              <Show when={props.goal.status === "paused"}>
                <Button data-action="session-goal-resume" size="small" variant="ghost" onClick={() => act("resume")}>
                  {language.t("session.goal.resume")}
                </Button>
              </Show>
              <Button data-action="session-goal-clear" size="small" variant="ghost-danger" onClick={() => act("clear")}>
                {language.t("session.goal.clear")}
              </Button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover>
    </div>
  )
}

function GoalGlyph(props: { status: SessionGoal.Status }) {
  return (
    <svg
      data-slot="session-goal-glyph"
      data-status={props.status}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      aria-hidden="true"
      class="shrink-0"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" />
      <Show
        when={props.status === "complete"}
        fallback={<circle data-slot="session-goal-core" cx="8" cy="8" r="2.25" fill="currentColor" />}
      >
        <path
          d="M5.4 8.2 7.2 9.9 10.6 6.2"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </Show>
    </svg>
  )
}
