import { onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { ScrollView } from "@opencode/ui/scroll-view"
import { showToast } from "@opencode/ui/toast"
import { useExtension, type MountedSession } from "../sdk"
import { Loaded, McpList, NameList, Section } from "./cards"
import { globalConfigDirectory, serviceConfigFile } from "./config-file"
import type definition from "./index"
import { useConfig, useMcpServers, useMcpToggle, usePlugins, useSkills } from "./services"

type Service = "mcp" | "plugins" | "skills" | "lsp"

/** Everything the session's server has connected: MCP servers, plugins, skills and LSPs. */
export default function ExtensionsTab(props: { session: MountedSession; shown: boolean }) {
  const ctx = useExtension<typeof definition>()
  const sections = ctx.stores.sections

  const source = {
    session: () => props.session,
    directory: () => props.session.directory,
    shown: () => props.shown && !!props.session.directory,
  }
  const mcp = useMcpServers(source)
  const toggle = useMcpToggle(props.session, () => props.session.directory)
  const plugins = usePlugins(source)
  const skills = useSkills(source)
  const config = useConfig(source)

  const section = (id: Service) => ({
    id,
    open: !sections.value.closed.includes(id),
    onOpenChange: (open: boolean) =>
      sections.update((draft) => {
        draft.closed = open ? draft.closed.filter((item) => item !== id) : [...draft.closed, id]
      }),
  })

  return (
    <ScrollView class="@container h-full">
      {/* Cards keep a readable width; a wide tab fits two columns of them, start-aligned like the context tab. */}
      <div
        data-slot="session-extensions-content"
        class="grid grid-cols-[minmax(0,28rem)] items-start justify-start gap-2 px-4 pt-4 pb-6 md:px-6 md:pb-10 @[46rem]:grid-cols-[repeat(2,minmax(0,28rem))]"
      >
        <Section
          {...section("mcp")}
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
          <Actions session={props.session} service="mcp">
            <Button size="small" variant="ghost-muted" icon="mcp" onClick={() => ctx.layout.command("mcp.toggle")}>
              {ctx.t("mcp.manage")}
            </Button>
          </Actions>
        </Section>

        <Section {...section("plugins")} title={ctx.t("plugins")} summary={plugins.list().length || undefined}>
          <Loaded source={plugins} empty={plugins.list().length === 0} emptyText={ctx.t("plugins.empty")}>
            <NameList items={plugins.list()} />
          </Loaded>
          <Actions session={props.session} service="plugins" />
        </Section>

        <Section {...section("skills")} title={ctx.t("skills")} summary={skills.list().length || undefined}>
          <Loaded source={skills} empty={skills.list().length === 0} emptyText={ctx.t("skills.empty")}>
            <NameList
              items={skills.list().map((skill) => ({
                name: skill.name,
                open: () => ctx.links.open({ href: skill.path, session: props.session }),
              }))}
            />
          </Loaded>
          <Actions session={props.session} service="skills" />
        </Section>

        <Section {...section("lsp")} title={ctx.t("lsp")} summary={config.lsps().length || undefined}>
          <Loaded source={config} empty={config.lsps().length === 0} emptyText={ctx.t("lsp.empty")}>
            <NameList items={config.lsps().map((name) => ({ name }))} />
          </Loaded>
          <Actions session={props.session} service="lsp" />
        </Section>
      </div>
    </ScrollView>
  )
}

// A section's footer: its own actions, then setting the service up with OpenCode and its configuration file.
function Actions(props: { session: MountedSession; service: Service; children?: JSX.Element }) {
  const ctx = useExtension()
  const [store, setStore] = createStore({ busy: false, copied: false })
  const local = () => props.session.server.local
  // Clears the copied mark two seconds after the latest copy.
  let reset: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(reset))

  const run = (
    action: (entries: Awaited<ReturnType<MountedSession["server"]["client"]["config"]["get"]>>) => unknown,
  ) => {
    if (store.busy) return
    setStore("busy", true)
    void props.session.server.client.config
      .get({ location: { directory: props.session.directory } })
      .then(action)
      .catch((error) =>
        showToast({
          variant: "error",
          title: ctx.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setStore("busy", false))
  }

  const setup = () =>
    run((entries) =>
      ctx.layout.draft({
        server: props.session.server.id,
        directory: globalConfigDirectory(entries, props.session.directory),
        prompt: ctx.t(`setup.${props.service}.prompt`),
      }),
    )

  // A local file opens in a side tab; a remote server's path is copied.
  const configure = () =>
    run(async (entries) => {
      const path = serviceConfigFile(entries, props.service)

      if (!path) throw new Error(ctx.t("configFileMissing"))

      if (local()) {
        if (!ctx.links.open({ href: path, session: props.session })) await ctx.desktop?.reveal(path)

        return
      }

      await ctx.system.copy(path)
      setStore("copied", true)
      clearTimeout(reset)
      reset = setTimeout(() => setStore("copied", false), 2000)
    })

  return (
    <div class="mt-1 -ms-2 flex flex-wrap items-center gap-1">
      {props.children}
      <Button size="small" variant="ghost-muted" icon="plus" disabled={store.busy} onClick={setup}>
        {ctx.t(`setup.${props.service}`)}
      </Button>
      <Button
        size="small"
        variant="ghost-muted"
        icon={local() ? "settings-gear" : store.copied ? "check" : "outline-copy"}
        disabled={store.busy}
        onClick={configure}
      >
        <Show when={local()} fallback={ctx.t("copyConfigPath")}>
          {ctx.t("configure")}
        </Show>
      </Button>
    </div>
  )
}
