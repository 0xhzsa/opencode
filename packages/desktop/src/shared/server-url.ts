export function serverOrigin(value: string) {
  if (!URL.canParse(value)) return
  const url = new URL(value)

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    return

  return url.origin
}
