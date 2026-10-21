import { createMemo, on, onCleanup, For, Show } from "solid-js"
import { checksum } from "@opencode/util/encode"
import { Icon } from "@opencode/ui/icon"
import { Button } from "@opencode/ui/button"
import { Accordion } from "@opencode/ui/accordion"
import { Progress } from "@opencode/ui/progress"
import { StickyAccordionHeader } from "@opencode/ui/sticky-accordion-header"
import { ScrollView } from "@opencode/ui/scroll-view"
import { showToast } from "@opencode/ui/toast"
import { useI18n } from "@opencode/ui/context/i18n"
import { File } from "@opencode/session-ui/file"
import { Markdown } from "@opencode/session-ui/markdown"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { lastAssistantWithUsage } from "@opencode/client/solid"
import { createKeyed, useExtension, type MountedSession } from "../sdk"
import { useConfig, useMcpServers, useMcpToggle, usePlugins, useSkills } from "../details/services"
import { catalogModel, syncCatalog } from "./catalog"
import { fetchSessionExport, sessionExportFilename } from "./export"
import { createSessionContextFormatter } from "./format"
import { Loaded, McpList, NameList, Row, Section } from "./sections"

function RawMessageContent(props: { message: SessionMessageInfo; onRendered: () => void }) {
  const file = createMemo(() => {
    const contents = JSON.stringify(props.message, null, 2)

    return {
      name: `${props.message.type}-${props.message.id}.json`,
      contents,
      cacheKey: checksum(contents),
    }
  })

  return (
    <File
      mode="text"
      file={file()}
      overflow="wrap"
      class="select-text"
      onRendered={() => requestAnimationFrame(props.onRendered)}
    />
  )
}

function RawMessage(props: {
  message: SessionMessageInfo
  onRendered: () => void
  time: (value: number | undefined) => string
}) {
  return (
    <Accordion.Item value={props.message.id}>
      <StickyAccordionHeader>
        <Accordion.Trigger>
          <div class="flex items-center justify-between gap-2 w-full">
            <div class="min-w-0 truncate">
              {props.message.type} <span class="text-text-base">• {props.message.id}</span>
            </div>
            <div class="flex items-center gap-3">
              <div class="shrink-0 text-12-regular text-text-weak">{props.time(props.message.time.created)}</div>
              <Icon name="chevron-grabber-vertical" size="small" class="shrink-0 text-text-weak" />
            </div>
          </div>
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content class="bg-background-base">
        <div class="p-3">
          <RawMessageContent message={props.message} onRendered={props.onRendered} />
        </div>
      </Accordion.Content>
    </Accordion.Item>
  )
}

const emptyMessages: SessionMessageInfo[] = []

export default function SessionContextTab(props: { session: MountedSession }) {
  const ctx = useExtension()
  const layout = ctx.layout
  const system = ctx.system
  const i18n = useI18n()
  const data = () => props.session.server.data
  syncCatalog(() => props.session)

  const info = createMemo(() => (props.session.id ? data().session.get(props.session.id) : undefined))

  const messages = createMemo(
    () => {
      const id = props.session.id

      if (!id) return emptyMessages

      return data().session.message.list(id)
    },
    emptyMessages,
    { equals: same },
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(i18n.locale(), {
        style: "currency",
        currency: "USD",
      }),
  )

  // Same step as the TUI and the header button: after the last completed compaction and before an undo boundary.
  const context = createMemo(() => {
    const message = lastAssistantWithUsage(messages(), info()?.revert?.messageID)

    if (!message) return
    const entry = catalogModel(props.session, message.model)

    const total =
      message.tokens.input +
      message.tokens.output +
      message.tokens.reasoning +
      message.tokens.cache.read +
      message.tokens.cache.write

    return {
      message,
      tokens: message.tokens,
      providerLabel: entry?.provider.name ?? message.model.providerID,
      modelLabel: entry?.model?.name ?? message.model.id,
      limit: entry?.model?.limit.context,
      total,
      usage: entry?.model?.limit.context ? Math.round((total / entry.model.limit.context) * 100) : null,
    }
  })

  const formatter = createMemo(() => createSessionContextFormatter(i18n.locale()))

  // A root session's cost includes its subagent sessions, as in the TUI.
  const cost = createMemo(() => usd().format(props.session.id ? data().session.cost(props.session.id) : 0))

  const counts = createMemo(() => {
    const all = messages()

    return {
      all: all.length,
      user: all.filter((message) => message.type === "user").length,
      assistant: all.filter((message) => message.type === "assistant").length,
    }
  })

  const systemPrompt = createMemo(() =>
    messages()
      .findLast((message) => message.type === "system")
      ?.text?.trim(),
  )

  // Plugins, skills and LSPs belong to the session's location; a session without a directory has none to list.
  const source = {
    session: () => props.session,
    directory: () => props.session.directory,
    shown: () => !!props.session.directory,
  }
  const mcp = useMcpServers(source)
  const toggle = useMcpToggle(props.session, () => props.session.directory)
  const plugins = usePlugins(source)
  const skills = useSkills(source)
  const config = useConfig(source)

  const username = createMemo(() =>
    config
      .entries()
      ?.flatMap((entry) => (entry.type === "document" && entry.info.username ? [entry.info.username] : []))
      .at(-1),
  )

  const number = (value: number | null | undefined) => formatter().number(value)

  const tokens = createMemo(() => {
    const c = context()

    if (!c) return []

    return [
      { label: "stats.totalTokens", value: number(c.total) },
      { label: "stats.inputTokens", value: number(c.tokens.input) },
      { label: "stats.outputTokens", value: number(c.tokens.output) },
      { label: "stats.reasoningTokens", value: number(c.tokens.reasoning) },
      { label: "stats.cacheTokens", value: `${number(c.tokens.cache.read)} / ${number(c.tokens.cache.write)}` },
      { label: "stats.limit", value: number(c.limit) },
    ]
  })

  const metadata = createMemo(() => [
    { label: "stats.session", value: info()?.title ?? (props.session.id || "—") },
    ...(username() ? [{ label: "stats.username", value: username() }] : []),
    { label: "stats.provider", value: context()?.providerLabel ?? "—" },
    { label: "stats.model", value: context()?.modelLabel ?? "—" },
    { label: "stats.messages", value: counts().all.toLocaleString(i18n.locale()) },
    { label: "stats.userMessages", value: counts().user.toLocaleString(i18n.locale()) },
    { label: "stats.assistantMessages", value: counts().assistant.toLocaleString(i18n.locale()) },
    { label: "stats.sessionId", value: props.session.id || "—" },
    { label: "stats.sessionCreated", value: formatter().time(info()?.time.created) },
    { label: "stats.lastActivity", value: formatter().time(context()?.message.time.created) },
  ])

  const exportSession = async () => {
    const sessionID = props.session.id

    if (!sessionID) return

    try {
      const data = await fetchSessionExport({
        sessionID,
        api: props.session.server.client,
      })

      const filename = sessionExportFilename(data.info)

      if (!(await system.save({ name: filename, content: JSON.stringify(data, null, 2) }))) return
      showToast({
        variant: "success",
        // Solid resolves JSX accessors under the toast's render owner, not this imperative call site.
        icon: () => <Icon name="circle-check" />,
        title: ctx.t("export.success.title"),
        description: ctx.t("export.success.description", { filename }),
      })
    } catch (err) {
      showToast({
        variant: "error",
        title: ctx.t("export.failed.title"),
        description: err instanceof Error ? err.message : ctx.t("export.failed.description"),
      })
    }
  }

  let scroll: HTMLDivElement | undefined
  let frame: number | undefined
  let pending: { x: number; y: number } | undefined

  const restoreScroll = () => {
    const el = scroll

    if (!el) return

    const s = layout.scroll.get(props.session, "context")

    if (!s) return

    if (el.scrollTop !== s.y) el.scrollTop = s.y

    if (el.scrollLeft !== s.x) el.scrollLeft = s.x
  }

  const handleScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    pending = {
      x: event.currentTarget.scrollLeft,
      y: event.currentTarget.scrollTop,
    }

    if (frame !== undefined) return

    frame = requestAnimationFrame(() => {
      frame = undefined

      const next = pending
      pending = undefined

      if (!next) return

      layout.scroll.set(props.session, "context", next)
    })
  }

  // Restores the stored scroll a frame after the messages change; on mount the viewport ref restores it.
  createKeyed(
    createMemo(on(messages, (list) => list, { defer: true })),
    () => void requestAnimationFrame(restoreScroll),
  )

  onCleanup(() => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
  })

  return (
    <ScrollView
      class="@container h-full"
      viewportRef={(el) => {
        scroll = el
        restoreScroll()
      }}
      onScroll={handleScroll}
    >
      <div data-slot="session-usage-content" class="px-4 pt-4 pb-6 flex flex-col gap-2 md:px-6 md:pb-10">
        <Section
          id="context"
          title={ctx.t("tab.title")}
          summary={context()?.usage != null ? ctx.t("context.full", { percent: String(context()?.usage) }) : undefined}
        >
          <div class="flex flex-col gap-3">
            <Show
              when={context()}
              fallback={<div class="text-[13px] text-v2-text-text-faint">{ctx.t("context.empty")}</div>}
            >
              <Show when={context()?.usage != null}>
                <Progress
                  value={context()?.usage ?? 0}
                  minValue={0}
                  maxValue={100}
                  showValueLabel
                  getValueLabel={() => ctx.t("context.full", { percent: String(context()?.usage) })}
                >
                  {ctx.t("stats.usage")}
                </Progress>
              </Show>
              <div class="flex flex-col">
                <For each={tokens()}>{(row) => <Row label={ctx.t(row.label)} value={row.value} />}</For>
              </div>
            </Show>
            <Row label={ctx.t("stats.totalCost")} value={cost()} />
          </div>
        </Section>

        <Show when={props.session.directory}>
          <Section
            id="mcp"
            title={ctx.t("mcp.section")}
            summary={
              mcp.list().length
                ? ctx.t("mcp.summary", {
                    connected: String(mcp.list().filter((server) => server.status.status === "connected").length),
                    total: String(mcp.list().length),
                  })
                : undefined
            }
          >
            <Loaded source={mcp} empty={mcp.list().length === 0} emptyText={ctx.t("mcp.empty")}>
              <McpList session={props.session} servers={mcp.list()} toggle={toggle} />
            </Loaded>
            <Button
              size="small"
              variant="ghost-muted"
              icon="mcp"
              class="mt-1 -ms-2"
              onClick={() => ctx.layout.command("mcp.toggle")}
            >
              {ctx.t("mcp.manage")}
            </Button>
          </Section>

          <Section id="plugins" title={ctx.t("plugins")} summary={plugins.list().length || undefined}>
            <Loaded source={plugins} empty={plugins.list().length === 0} emptyText={ctx.t("plugins.empty")}>
              <NameList items={plugins.list()} />
            </Loaded>
          </Section>

          <Section id="skills" title={ctx.t("skills")} summary={skills.list().length || undefined}>
            <Loaded source={skills} empty={skills.list().length === 0} emptyText={ctx.t("skills.empty")}>
              <NameList items={skills.list()} />
            </Loaded>
          </Section>

          <Section id="lsp" title={ctx.t("lsp")} summary={config.lsps().length || undefined}>
            <Loaded source={config} empty={config.lsps().length === 0} emptyText={ctx.t("lsp.empty")}>
              <NameList items={config.lsps().map((name) => ({ name }))} />
            </Loaded>
          </Section>
        </Show>

        <Section id="system" title={ctx.t("systemPrompt.title")}>
          <Show
            when={systemPrompt()}
            fallback={<div class="text-[13px] text-v2-text-text-faint">{ctx.t("systemPrompt.empty")}</div>}
          >
            {(prompt) => <Markdown text={prompt()} class="text-12-regular" />}
          </Show>
        </Section>

        <Section id="advanced" title={ctx.t("advanced.title")}>
          <div class="flex flex-col gap-4">
            <div class="flex flex-col">
              <For each={metadata()}>{(row) => <Row label={ctx.t(row.label)} value={row.value} />}</For>
            </div>
            <div class="flex flex-col gap-2">
              <div class="flex items-center justify-between">
                <div class="text-12-regular text-text-weak">{ctx.t("rawMessages.title")}</div>
                <Button
                  size="small"
                  variant="ghost"
                  class="gap-1.5 px-2 text-text-weak hover:text-text-base"
                  onClick={exportSession}
                >
                  <Icon name="download" size="small" />
                  <span>{ctx.t("export.session")}</span>
                </Button>
              </div>
              <Accordion multiple>
                <For each={messages()}>
                  {(message) => <RawMessage message={message} onRendered={restoreScroll} time={formatter().time} />}
                </For>
              </Accordion>
            </div>
          </div>
        </Section>
      </div>
    </ScrollView>
  )
}

function same<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  if (a === b) return true

  if (!a || !b) return false

  if (a.length !== b.length) return false

  return a.every((x, i) => x === b[i])
}
