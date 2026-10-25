import { Option, Schema } from "effect"

export type DeepLink = { type: "session"; sessionID: string; server?: string } | { type: "console"; windowID: string }

const MAX_LINK_LENGTH = 2048

const SESSION_ID = /^ses_[0-9A-Za-z]{8,64}$/

// A client-local server key: "sidecar" or an extension's `${extension}:${id}`.
const SERVER_KEY = /^[\w.@:-]{1,256}$/

/** Reads an `opencode://` link, or nothing when it is not one this app opens. */
export function parseDeepLink(value: string): DeepLink | undefined {
  if (value.length > MAX_LINK_LENGTH || /[\s\u0000-\u001f\u007f]/.test(value)) return
  const url = URL.parse(value)

  if (!url || url.protocol !== "opencode:" || url.username || url.password || url.port || url.hash) return

  if (url.hostname === "session") return sessionLink(url)

  if (url.hostname === "console") return consoleLink(url)
}

/** The canonical form handed to the renderer: only the fields this parser accepted. */
export function formatDeepLink(link: Extract<DeepLink, { type: "session" }>) {
  const query = link.server ? `?${new URLSearchParams({ server: link.server })}` : ""

  return `opencode://session/${link.sessionID}${query}`
}

const Tabs = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({ sessionId: Schema.optional(Schema.String), routeSessionId: Schema.optional(Schema.String) }),
  ),
)

const decodeTabs = Schema.decodeUnknownOption(Tabs)

/** Whether a window's persisted `tabs` value has a tab showing this session. */
export function tabsHoldSession(value: string | null, sessionID: string) {
  if (!value) return false

  return Option.match(decodeTabs(value), {
    onNone: () => false,
    onSome: (tabs) => tabs.some((tab) => tab.sessionId === sessionID || tab.routeSessionId === sessionID),
  })
}

function sessionLink(url: URL): DeepLink | undefined {
  const sessionID = url.pathname.slice(1)

  if (!SESSION_ID.test(sessionID)) return
  const keys = [...url.searchParams.keys()]

  if (keys.some((key) => key !== "server") || keys.length > 1) return
  const hint = url.searchParams.get("server")

  if (hint === null) return { type: "session", sessionID }
  const server = serverHint(hint)

  if (!server) return

  return { type: "session", sessionID, server }
}

function consoleLink(url: URL): DeepLink | undefined {
  if (url.pathname !== "/authorized") return
  const windowID = url.searchParams.get("window")

  if (!windowID || windowID.length > 256 || /[\u0000-\u001f\u007f]/.test(windowID)) return

  return { type: "console", windowID }
}

// An http(s) origin is the portable form; anything else is a key only the device that made it knows.
function serverHint(value: string) {
  if (!/^https?:/i.test(value)) return SERVER_KEY.test(value) ? value : undefined
  const url = URL.parse(value)

  if (!url || url.username || url.password || url.search || url.hash) return

  if (url.pathname !== "/" && url.pathname !== "") return

  return url.origin
}
