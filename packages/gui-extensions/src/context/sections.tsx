import { Collapsible } from "@kobalte/core/collapsible"
import { For, Index, Show, type JSX } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { TruncatedText } from "@opencode/ui/truncated-text"
import { useExtension, type MountedSession } from "../sdk"
import { McpServerControl, useMcpRow, type McpServer, type McpToggle } from "../details/services"
import type definition from "./index"

/** A collapsible card whose open state lives in the extension's `sections` store. */
export function Section(props: {
  id: string
  title: string
  summary?: JSX.Element
  actions?: JSX.Element
  children: JSX.Element
}) {
  const sections = useExtension<typeof definition>().stores.sections
  const open = () => sections.value.open.includes(props.id)

  return (
    <Collapsible
      data-section={props.id}
      class="rounded-lg bg-v2-background-bg-layer-01"
      open={open()}
      onOpenChange={(value) =>
        sections.update((draft) => {
          draft.open = value ? [...draft.open, props.id] : draft.open.filter((id) => id !== props.id)
        })
      }
    >
      <div class="flex min-h-10 items-center gap-2 ps-3 pe-2">
        <Collapsible.Trigger class="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-start">
          <Icon
            name="chevron-down"
            size="small"
            class="shrink-0 text-v2-icon-icon-muted transition-transform"
            classList={{ "-rotate-90 rtl:rotate-90": !open() }}
          />
          <span class="shrink-0 text-[13px] font-medium text-v2-text-text-base">{props.title}</span>
          <Show when={props.summary}>
            <span class="min-w-0 truncate text-[13px] text-v2-text-text-faint">{props.summary}</span>
          </Show>
        </Collapsible.Trigger>
        <Show when={props.actions}>
          <div class="flex shrink-0 items-center">{props.actions}</div>
        </Show>
      </div>
      <Collapsible.Content class="px-3 pb-3">{props.children}</Collapsible.Content>
    </Collapsible>
  )
}

/** A label and its value on one line. */
export function Row(props: { label: string; value: JSX.Element }) {
  return (
    <div class="flex min-h-7 items-baseline justify-between gap-3 text-[13px]">
      <span class="shrink-0 text-v2-text-text-muted">{props.label}</span>
      <span class="min-w-0 truncate text-end tabular-nums text-v2-text-text-base select-text">{props.value}</span>
    </div>
  )
}

/** Loading, failure and empty states around a loaded list. */
export function Loaded(props: {
  source: { loading: () => boolean; ready: () => boolean; error: () => unknown; retry: () => void }
  empty: boolean
  emptyText: string
  children: JSX.Element
}) {
  const ctx = useExtension()

  return (
    <Show
      when={props.source.ready() || !props.source.loading()}
      fallback={<div class="py-1 text-[13px] text-v2-text-text-faint">{ctx.t("common.loading")}</div>}
    >
      <Show
        when={!props.source.error()}
        fallback={
          <div class="flex items-center justify-between gap-2 py-1 text-[13px] text-v2-text-text-faint">
            <span>{ctx.t("common.requestFailed")}</span>
            <Button size="small" variant="ghost" onClick={() => props.source.retry()}>
              {ctx.t("retry")}
            </Button>
          </div>
        }
      >
        <Show
          when={!props.empty}
          fallback={<div class="py-1 text-[13px] text-v2-text-text-faint">{props.emptyText}</div>}
        >
          {props.children}
        </Show>
      </Show>
    </Show>
  )
}

/** Names with a status dot, as the details panel lists plugins, skills and LSPs. */
export function NameList(props: { items: readonly { name: string; status?: string; error?: string }[] }) {
  const ctx = useExtension()

  return (
    <div class="flex flex-col">
      <For each={props.items}>
        {(item) => (
          <div class="flex min-h-8 items-center gap-2 text-[13px]" title={item.error ?? item.name}>
            <StatusDot status={item.status ?? "active"} />
            <span dir="auto" class="min-w-0 flex-1 truncate text-v2-text-text-base">
              {item.name}
            </span>
            <Show when={item.status === "failed"}>
              <span class="shrink-0 text-v2-state-fg-danger">{ctx.t("failed")}</span>
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}

export function McpList(props: { session: MountedSession; servers: readonly McpServer[]; toggle: McpToggle }) {
  const ctx = useExtension()

  return (
    <div class="flex flex-col">
      <Index each={props.servers}>
        {(server) => {
          const row = useMcpRow({
            session: props.session,
            directory: props.session.directory,
            server,
            toggle: props.toggle,
          })

          return (
            <div class="flex min-h-11 items-center gap-2 py-1">
              <StatusDot status={server().status.status} />
              <div class="flex min-w-0 flex-1 flex-col">
                <TruncatedText text={server().name} class="text-[13px] text-v2-text-text-base" />
                <span
                  class="truncate text-12-regular"
                  classList={{
                    "text-v2-text-text-faint": !row.failed() && server().status.status !== "needs_auth",
                    "text-v2-state-fg-danger": row.failed(),
                    "text-v2-state-fg-warning": server().status.status === "needs_auth",
                  }}
                >
                  {row.label()}
                </span>
              </div>
              <div class="flex shrink-0 items-center gap-1 [&_[data-slot=switch-label]]:sr-only">
                <Show when={row.failed()}>
                  <Button size="small" variant="ghost" disabled={row.pending()} onClick={() => row.change(true)}>
                    {ctx.t("retry")}
                  </Button>
                </Show>
                <McpServerControl server={server()} row={row} />
              </div>
            </div>
          )
        }}
      </Index>
    </div>
  )
}

function StatusDot(props: { status: string }) {
  return (
    <span
      aria-hidden="true"
      class="size-2 shrink-0 rounded-full"
      classList={{
        "bg-icon-success-base": props.status === "connected" || props.status === "active",
        "bg-icon-critical-base": props.status === "failed",
        "bg-icon-warning-base": props.status === "needs_auth",
        "bg-v2-icon-icon-faint": !["connected", "active", "failed", "needs_auth"].includes(props.status),
      }}
    />
  )
}
