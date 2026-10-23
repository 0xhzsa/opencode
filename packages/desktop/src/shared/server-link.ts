import { serverOrigin } from "./server-url"

/** Deep links are untrusted: allow only connection metadata, never credentials. */
export function parseServerLink(value: string) {
  if (!URL.canParse(value)) return
  const link = new URL(value)

  if (
    link.protocol !== "opencode:" ||
    link.hostname !== "add-server" ||
    (link.pathname && link.pathname !== "/") ||
    link.username ||
    link.password ||
    link.port ||
    link.hash
  )
    return
  const keys = [...link.searchParams.keys()]

  if (keys.some((key) => !["url", "name", "default"].includes(key)) || new Set(keys).size !== keys.length) return
  const url = serverOrigin(link.searchParams.get("url") ?? "")
  const name = link.searchParams.get("name") ?? undefined
  const defaultValue = link.searchParams.get("default")

  if (!url || (name !== undefined && (!name.trim() || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name)))) return

  if (defaultValue !== null && defaultValue !== "0" && defaultValue !== "1") return

  return { url, name, default: defaultValue === "1" }
}
