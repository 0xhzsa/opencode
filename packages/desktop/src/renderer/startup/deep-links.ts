import type { ElectronAPI } from "../api-types"
import { parseServerLink } from "../../shared/server-link"

const deepLinkEvent = "opencode:deep-link"

/** Called once the app is mounted, so a native confirmation has a visible parent window. */
export function listenServerLinks(api: ElectronAPI, changed: () => Promise<void>) {
  let queue = Promise.resolve()

  const consume = () => {
    const links = window.__OPENCODE__?.deepLinks ?? []
    const servers = links.filter((url) => parseServerLink(url))

    if (!servers.length) return

    if (window.__OPENCODE__) window.__OPENCODE__.deepLinks = links.filter((url) => !parseServerLink(url))

    for (const url of servers)
      queue = queue
        .then(async () => {
          if (await api.confirmServerLink(url)) await changed()
        })
        .catch(() => undefined)
  }

  window.addEventListener(deepLinkEvent, consume)
  consume()

  return () => window.removeEventListener(deepLinkEvent, consume)
}

export function startDeepLinks(api: ElectronAPI) {
  void api.consumeInitialDeepLinks().then(emitDeepLinks)
  api.onDeepLink(emitDeepLinks)
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  window.__OPENCODE__ ??= {}
  window.__OPENCODE__.deepLinks = [...(window.__OPENCODE__.deepLinks ?? []), ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}
