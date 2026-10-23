import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseServerLink } from "../../shared/server-link"
import { createSettingsStore } from "../storage/store"
import { confirmServerLink, serverLinkConfirmation } from "./add-server-link"

const url = "https://studio.example:4096"

const link = `opencode://add-server?url=${encodeURIComponent(url)}&name=Studio&default=1`

const roots: string[] = []

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

test("server links parse connection metadata and an optional default", () => {
  expect(parseServerLink(link)).toEqual({ url, name: "Studio", default: true })
  expect(parseServerLink(`opencode://add-server?url=${encodeURIComponent(`${url}/`)}`)).toEqual({
    url,
    name: undefined,
    default: false,
  })
})

test("confirmation emphasizes the origin and labels an untrusted name as coming from the link", () => {
  const prompt = serverLinkConfirmation({ url: "https://unrelated.example", name: "Studio", default: true })

  expect(prompt.message).toBe("https://unrelated.example")
  expect(prompt.detail).toContain("Name from link: Studio")
  expect(prompt.detail).toContain("Use this server by default")
  expect(prompt.buttons?.[prompt.defaultId ?? -1]).toBe("Cancel")
})

test.each([
  "invalid",
  "https://add-server?url=https://example.com",
  "opencode://add-server/path?url=https://example.com",
  "opencode://add-server?url=file:///private",
  "opencode://add-server?url=https://user:password@example.com",
  "opencode://add-server?url=https://example.com/path",
  "opencode://add-server?url=https://example.com&password=secret",
  "opencode://add-server?url=https://example.com&passwordFile=/private/file",
  "opencode://add-server?url=https://example.com&token=secret",
  "opencode://add-server?url=https://example.com&url=https://other.example",
  "opencode://add-server?url=https://example.com&default=true",
  "opencode://add-server?url=https://example.com&name=%0Ahidden",
  "opencode://add-server?url=https://example.com#password",
])("rejects unsafe or ambiguous links: %s", (value) => {
  expect(parseServerLink(value)).toBeUndefined()
})

test("no write occurs until confirmation, and cancellation leaves settings byte-for-byte intact", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "desktop-server-link-"))
  roots.push(root)
  const store = createSettingsStore(path.join(root, "opencode.settings"))
  store.set("backgroundColor", "#000000")
  const before = readFileSync(store.path, "utf8")
  const confirmation = Promise.withResolvers<boolean>()

  const operation = confirmServerLink(link, store, async (request) => {
    expect(request.url).toBe(url)
    expect(request.default).toBe(true)

    return confirmation.promise
  })

  expect(readFileSync(store.path, "utf8")).toBe(before)
  confirmation.resolve(false)
  expect(await operation).toBe(false)
  expect(readFileSync(store.path, "utf8")).toBe(before)
  expect(
    await confirmServerLink(`${link}&password=forbidden`, store, async () => {
      throw new Error("must not prompt")
    }),
  ).toBe(false)
  expect(await confirmServerLink(link, store, async () => true)).toBe(true)
  expect(store.get("servers")).toEqual([{ url, name: "Studio" }])
  expect(store.get("defaultServer")).toBe(url)
  expect(store.get("backgroundColor")).toBe("#000000")
  expect(store.get("startLocalServer")).toBeUndefined()

  // Reopening a link preserves both existing credentials and an explicit local-start override.
  store.set("servers", [{ url, name: "My Studio", passwordFile: "private.password" }])
  store.set("startLocalServer", true)
  await confirmServerLink(link, store, async () => true)
  expect(store.get("servers")).toEqual([{ url, name: "My Studio", passwordFile: "private.password" }])
  expect(store.get("startLocalServer")).toBe(true)
})
