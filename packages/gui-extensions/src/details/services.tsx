import type { PluginInfo } from "@opencode/client"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { ErrorDetails } from "@opencode/ui/error-details"
import { Switch } from "@opencode/ui/switch"
import { showToast } from "@opencode/ui/toast"
import { useMutation } from "@tanstack/solid-query"
import { createMemo, createResource, createSignal, onCleanup, Show } from "solid-js"
import { createKeyed, useExtension, type MountedSession } from "../sdk"
import { configuredLsps } from "./configured-lsp"

// The session server's MCP servers, plugins, skills and LSPs, as the extensions tab lists them.

export type McpServer = NonNullable<
  ReturnType<MountedSession["server"]["data"]["location"]["mcp"]["server"]["list"]>
>[number]

export type McpToggle = ReturnType<typeof useMcpToggle>

type Source = {
  session: () => MountedSession
  directory: () => string
  shown: () => boolean
}

/** The location's MCP servers by name, loaded again whenever they are shown. */
export function useMcpServers(source: Source) {
  const data = () => source.session().server.data

  const [load, { refetch }] = createResource(
    () => source.shown() && data(),
    async (current) => {
      const directory = source.directory()

      current.location.mcp.server.invalidate({ directory })
      await current.location.mcp.server.sync({ directory })
    },
  )

  const list = createMemo(() =>
    (data().location.mcp.server.list({ directory: source.directory() }) ?? []).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    ),
  )

  return {
    list,
    loading: () => load.loading,
    error: () => load.error,
    ready: () => data().location.mcp.server.list({ directory: source.directory() }) !== undefined,
    retry: refetch,
  }
}

/** The location's plugins other than built-ins, loaded again when shown and when they change. */
export function usePlugins(source: Source) {
  const data = () => source.session().server.data

  const [items, { refetch }] = createResource(
    () => source.shown() && data(),
    async () => {
      const result = await source.session().server.client.plugin.list({ location: { directory: source.directory() } })

      return result.data
        .filter((plugin) => plugin.source.type !== "builtin")
        .map((plugin) => ({
          name: pluginLabel(plugin),
          status: plugin.state.status,
          error: plugin.state.status === "failed" ? plugin.state.error : undefined,
        }))
    },
  )

  createKeyed(data, (current) =>
    onCleanup(
      current.on("plugin.updated", (event) => {
        if (event.location?.directory !== source.directory()) return
        void refetch()
      }),
    ),
  )

  const ready = () => items.state === "ready" || items.state === "refreshing"

  return {
    list: createMemo(() => (ready() ? (items.latest ?? []) : []).toSorted((a, b) => a.name.localeCompare(b.name))),
    loading: () => items.loading,
    error: () => items.error,
    ready,
    retry: refetch,
  }
}

/** The location's skills, loaded again when shown and when they change. */
export function useSkills(source: Source) {
  const data = () => source.session().server.data

  const [load, { refetch }] = createResource(
    () => source.shown() && data(),
    async (current) => {
      const directory = source.directory()

      current.location.skill.invalidate({ directory })
      await current.location.skill.sync({ directory })
    },
  )

  createKeyed(data, (current) =>
    onCleanup(
      current.on("skill.updated", (event) => {
        if (event.location?.directory !== source.directory()) return
        void refetch()
      }),
    ),
  )

  return {
    list: createMemo(() =>
      (data().location.skill.list({ directory: source.directory() }) ?? [])
        .map((skill) => ({ name: skill.name, path: skill.path }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    ),
    loading: () => load.loading,
    error: () => load.error,
    ready: () => data().location.skill.list({ directory: source.directory() }) !== undefined,
    retry: refetch,
  }
}

/** The location's configuration documents, loaded again when shown and when they change. */
export function useConfig(source: Source) {
  const data = () => source.session().server.data

  const [load, { refetch }] = createResource(
    () => source.shown() && data(),
    (current) => {
      const directory = source.directory()

      current.location.config.invalidate({ directory })

      return current.location.config.sync({ directory })
    },
  )

  createKeyed(data, (current) =>
    onCleanup(
      current.on("config.updated", (event) => {
        if (event.location?.directory !== source.directory()) return
        void refetch()
      }),
    ),
  )

  const entries = () => data().location.config.list({ directory: source.directory() })

  return {
    entries,
    lsps: createMemo(() => configuredLsps(entries() ?? [])),
    loading: () => load.loading,
    error: () => load.error,
    ready: () => entries() !== undefined,
    retry: refetch,
  }
}

/** One MCP row's state and actions. `follow` is the whole-row action: details, sign in, or toggling the server. */
export function useMcpRow(props: {
  session: MountedSession
  directory: string
  server: () => McpServer
  toggle: McpToggle
}) {
  const ctx = useExtension()
  const status = () => props.server().status.status
  const enabled = () => status() !== "disabled"
  const pending = () => props.toggle.isPending || status() === "pending"
  const failed = () => status() === "failed"
  const signIn = () => status() === "needs_auth" && !!props.server().integrationID
  const busy = () => props.toggle.isPending && props.toggle.variables?.name === props.server().name

  const label = () => {
    if (status() === "pending") return ctx.t("connecting")

    if (status() === "needs_auth") return ctx.t("needsAuth")

    if (status() === "failed") return ctx.t("failed")

    return ctx.t(status() === "connected" ? "mcp.connected" : "mcp.disabled")
  }

  const change = (value: boolean) => {
    if (pending()) return
    props.toggle.mutate({ name: props.server().name, enabled: value })
  }

  const showError = () =>
    ctx.dialogs.open((dialog) => (
      <McpErrorDialog
        session={props.session}
        directory={props.directory}
        name={props.server().name}
        onClose={dialog.close}
      />
    ))

  const follow = () => {
    if (failed()) return showError()
    change(status() === "needs_auth" || !enabled())
  }

  return { status, enabled, pending, failed, signIn, busy, label, change, follow }
}

/** A row's trailing control: a switch, or Sign in for servers that need it, or Details for failed servers. */
export function McpServerControl(props: { server: McpServer; row: ReturnType<typeof useMcpRow> }) {
  const ctx = useExtension()

  return (
    <Show
      when={props.row.failed() || props.row.signIn()}
      fallback={
        <Switch
          checked={props.row.enabled()}
          readOnly={props.row.pending()}
          aria-disabled={props.row.pending()}
          aria-busy={props.row.busy()}
          description={props.server.status.status === "pending" ? props.row.label() : undefined}
          class="[&_[data-slot=switch-description]]:sr-only"
          onChange={props.row.change}
        >
          <span class="sr-only">{props.server.name}</span>
          <span aria-hidden="true">{props.row.label()}</span>
        </Switch>
      }
    >
      <Button
        size="small"
        variant="neutral"
        disabled={props.row.signIn() && props.row.pending()}
        aria-busy={props.row.busy()}
        aria-label={ctx.t(props.row.failed() ? "mcp.error.actionLabel" : "mcp.signIn.open", {
          name: props.server.name,
        })}
        onClick={props.row.follow}
      >
        <Show when={props.row.failed()} fallback={ctx.t(props.row.busy() ? "mcp.signingIn" : "mcp.signIn")}>
          {ctx.t("mcp.error.action")}
        </Show>
      </Button>
    </Show>
  )
}

// Connects, disconnects, or starts sign-in for one of the session server's MCPs, like the app's MCP toggle.
export function useMcpToggle(session: MountedSession, directory: () => string) {
  const ctx = useExtension()
  const system = ctx.system
  const data = () => session.server.data

  return useMutation(() => ({
    mutationFn: async (input: { name: string; enabled: boolean }) => {
      const client = session.server.client
      const source = data()
      const ref = { directory: directory() }
      const server = (await client.mcp.list({ location: ref })).data.find((item) => item.name === input.name)

      if (!server) return

      if (!input.enabled) {
        await client.mcp.disconnect({ server: input.name, location: ref })
      }

      if (input.enabled && server.status.status !== "needs_auth") {
        await client.mcp.connect({ server: input.name, location: ref })
      }

      source.location.mcp.server.invalidate(ref)
      await source.location.mcp.server.sync(ref)
      const current = source.location.mcp.server.list(ref)?.find((item) => item.name === input.name)

      if (input.enabled && current?.status.status === "needs_auth" && current.integrationID) {
        const integration = await client.integration.get({ integrationID: current.integrationID, location: ref })
        const method = integration.data?.methods.find((item) => item.type === "oauth" && !item.form?.length)

        if (!method || method.type !== "oauth") throw new Error(ctx.t("mcp.interactiveAuth", { name: input.name }))

        const attempt = await client.integration.oauth.connect({
          integrationID: current.integrationID,
          methodID: method.id,
          location: ref,
        })

        system.openExternal(attempt.data.url)
      }

      source.location.mcp.resource.invalidate(ref)
      await source.location.mcp.resource.sync(ref)
      // A successful HTTP response can still leave the MCP connection in a failed state.
      const status = current?.status

      if (status?.status === "failed") throw new Error(`${input.name}: ${status.error}`)
    },
    onError: (error) =>
      showToast({
        variant: "error",
        title: ctx.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      }),
  }))
}

// The MCPs dialog's error view, for a listed server. It reads the server's own data, so it outlives the menu or tab
// that opened it.
function McpErrorDialog(props: { session: MountedSession; directory: string; name: string; onClose: () => void }) {
  const ctx = useExtension()
  const toggle = useMcpToggle(props.session, () => props.directory)
  const [copied, setCopied] = createSignal(false)

  const failure = () => {
    const server = props.session.server.data.location.mcp.server
      .list({ directory: props.directory })
      ?.find((item) => item.name === props.name)

    return server?.status.status === "failed" ? { name: server.name, error: server.status.error } : undefined
  }

  // A successful retry, disabling, or a removed server leaves nothing to show.
  createKeyed(
    () => !!failure(),
    () => undefined,
    { otherwise: props.onClose },
  )

  return (
    <Show when={failure()}>
      {(current) => (
        <Dialog class="session-mcp-error">
          <DialogHeader>
            <DialogTitleGroup
              title={
                <span dir="auto" class="[overflow-wrap:anywhere]">
                  {current().name}
                </span>
              }
              description={ctx.t("mcp.error.status")}
            />
          </DialogHeader>
          <DialogBody class="flex min-h-0 flex-1 flex-col">
            <ErrorDetails error={current().error}>
              <Button
                class="error-details-copy"
                variant="ghost-muted"
                icon={copied() ? "check" : "copy"}
                onClick={() =>
                  void ctx.system
                    .copy(ctx.t("mcp.error.details", { name: current().name, error: current().error }))
                    .then(() => setCopied(true))
                    .catch((error) =>
                      showToast({
                        variant: "error",
                        title: ctx.t("mcp.error.copyFailed"),
                        description: error instanceof Error ? error.message : String(error),
                      }),
                    )
                }
              >
                {ctx.t(copied() ? "common.copied" : "mcp.error.copy")}
              </Button>
              <Button
                variant="ghost"
                disabled={toggle.isPending}
                onClick={() => toggle.mutate({ name: props.name, enabled: false })}
              >
                {ctx.t("mcp.error.disable")}
              </Button>
              <Button
                variant="neutral"
                disabled={toggle.isPending}
                onClick={() => toggle.mutate({ name: props.name, enabled: true })}
              >
                {ctx.t("common.retry")}
              </Button>
            </ErrorDetails>
          </DialogBody>
        </Dialog>
      )}
    </Show>
  )
}

function pluginLabel(plugin: PluginInfo) {
  if (plugin.id) return plugin.id

  if (plugin.source.type === "package") return plugin.source.target

  if (plugin.source.type === "local") return plugin.source.path

  return plugin.source.type
}
