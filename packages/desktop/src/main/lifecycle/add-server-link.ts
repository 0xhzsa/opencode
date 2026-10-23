import { parseServerLink } from "../../shared/server-link"
import { parseServerSettings } from "../service/server-settings"
import type { SettingsStore } from "../storage/store"
import { nativeT } from "../native/translations"
import type { MessageBoxOptions } from "electron"

export function serverLinkConfirmation(server: NonNullable<ReturnType<typeof parseServerLink>>): MessageBoxOptions {
  return {
    type: "question",
    title: nativeT("desktop.serverLink.title"),
    message: server.url,
    detail: [
      server.name ? nativeT("desktop.serverLink.name", { name: server.name }) : undefined,
      server.default ? nativeT("desktop.serverLink.default") : undefined,
    ]
      .filter(Boolean)
      .join("\n\n"),
    buttons: [nativeT("desktop.serverLink.cancel"), nativeT("desktop.serverLink.add")],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
}

/** Confirmation is the mutation boundary, including when invoked directly over IPC. */
export async function confirmServerLink(
  value: string,
  store: SettingsStore,
  confirm: (server: NonNullable<ReturnType<typeof parseServerLink>>) => Promise<boolean>,
) {
  const server = parseServerLink(value)

  if (!server || !(await confirm(server))) return false

  const settings = parseServerSettings({
    servers: store.get("servers"),
    defaultServer: store.get("defaultServer"),
    startLocalServer: store.get("startLocalServer"),
  })

  // Re-adding an existing URL must not replace its credential reference or configured name.
  if (!settings.servers.some((item) => item.url === server.url))
    store.set("servers", [...settings.servers, { url: server.url, name: server.name }])

  if (server.default) store.set("defaultServer", server.url)

  return true
}
