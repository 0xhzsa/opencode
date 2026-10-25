import { describe, expect, test } from "bun:test"
import { formatDeepLink, parseDeepLink, tabsHoldSession } from "./deep-link"

const session = "ses_efcd8972fffeT5zZbj9YtIl3LU"

describe("parseDeepLink", () => {
  test("reads session links", () => {
    expect(parseDeepLink(`opencode://session/${session}`)).toEqual({ type: "session", sessionID: session })
    expect(parseDeepLink(`opencode://session/${session}?server=https://devbox.example.com:4096`)).toEqual({
      type: "session",
      sessionID: session,
      server: "https://devbox.example.com:4096",
    })
    expect(
      parseDeepLink(
        `opencode://session/${session}?server=${encodeURIComponent("https://devbox.example.com:4096/")}`,
      ),
    ).toEqual({ type: "session", sessionID: session, server: "https://devbox.example.com:4096" })
    expect(parseDeepLink(`opencode://session/${session}?server=sidecar`)).toEqual({
      type: "session",
      sessionID: session,
      server: "sidecar",
    })
    expect(parseDeepLink(`opencode://session/${session}?server=ssh:devbox`)?.type).toBe("session")
  })

  test("reads the originating window of a console sign-in", () => {
    expect(parseDeepLink("opencode://console/authorized?window=window-a")).toEqual({
      type: "console",
      windowID: "window-a",
    })
    expect(parseDeepLink("opencode://console/authorized?window=window%20b")).toEqual({
      type: "console",
      windowID: "window b",
    })
  })

  test("rejects other schemes, hosts and paths", () => {
    expect(parseDeepLink(`https://session/${session}`)).toBeUndefined()
    expect(parseDeepLink(`opencode-evil://session/${session}`)).toBeUndefined()
    expect(parseDeepLink(`opencode://new-session/${session}`)).toBeUndefined()
    expect(parseDeepLink(`opencode://SESSION/${session}`)).toBeUndefined()
    expect(parseDeepLink(`opencode://session/${session}/messages`)).toBeUndefined()
    expect(parseDeepLink(`opencode://user:pw@session/${session}`)).toBeUndefined()
    expect(parseDeepLink(`opencode://session:80/${session}`)).toBeUndefined()
    expect(parseDeepLink(`opencode://session/${session}#prompt`)).toBeUndefined()
    expect(parseDeepLink("opencode://console/other?window=window-a")).toBeUndefined()
    expect(parseDeepLink("opencode://console/authorized")).toBeUndefined()
    expect(parseDeepLink("not a url")).toBeUndefined()
  })

  test("rejects malformed session IDs", () => {
    expect(parseDeepLink("opencode://session/")).toBeUndefined()
    expect(parseDeepLink("opencode://session/abc")).toBeUndefined()
    expect(parseDeepLink("opencode://session/ses_..%2F..%2Fetc")).toBeUndefined()
    expect(parseDeepLink("opencode://session/ses_%41%41%41%41%41%41%41%41")).toBeUndefined()
    expect(parseDeepLink(`opencode://session/${session}%00`)).toBeUndefined()
    expect(parseDeepLink(`opencode://session/ses_${"a".repeat(65)}`)).toBeUndefined()
  })

  test("rejects unknown, repeated and unsafe parameters", () => {
    expect(parseDeepLink(`opencode://session/${session}?prompt=rm%20-rf`)).toBeUndefined()
    expect(parseDeepLink(`opencode://session/${session}?server=sidecar&server=other`)).toBeUndefined()
    expect(parseDeepLink(`opencode://session/${session}?server=javascript:alert(1)`)).toBeUndefined()
    expect(parseDeepLink(`opencode://session/${session}?server=file:///etc/passwd`)).toBeUndefined()
    expect(parseDeepLink(`opencode://session/${session}?server=https://user:pw@host`)).toBeUndefined()
    expect(parseDeepLink(`opencode://session/${session}?server=https://host/path`)).toBeUndefined()
    expect(
      parseDeepLink(`opencode://session/${session}?server=${encodeURIComponent("https://host/?a=1")}`),
    ).toBeUndefined()
    expect(parseDeepLink(`opencode://session/${session}?server=${encodeURIComponent("side car")}`)).toBeUndefined()
    expect(parseDeepLink(`opencode://session/${session}?server=`)).toBeUndefined()
    expect(parseDeepLink(`opencode://session/${session} `)).toBeUndefined()
    expect(parseDeepLink(`opencode://session/${session}\n`)).toBeUndefined()
    expect(parseDeepLink("opencode://console/authorized?window=a%0Ab")).toBeUndefined()
  })

  test("rejects oversized links and values", () => {
    expect(parseDeepLink(`opencode://session/${session}?server=${"a".repeat(2100)}`)).toBeUndefined()
    expect(parseDeepLink(`opencode://session/${session}?server=${"a".repeat(257)}`)).toBeUndefined()
    expect(parseDeepLink(`opencode://console/authorized?window=${"a".repeat(257)}`)).toBeUndefined()
  })

  test("formats only the accepted fields", () => {
    expect(formatDeepLink({ type: "session", sessionID: session })).toBe(`opencode://session/${session}`)
    const link = parseDeepLink(`opencode://session/${session}?server=https://host:4096/`)
    expect(link?.type === "session" && formatDeepLink(link)).toBe(
      `opencode://session/${session}?server=https%3A%2F%2Fhost%3A4096`,
    )
    expect(parseDeepLink(`opencode://session/${session}?server=https%3A%2F%2Fhost%3A4096`)).toEqual(link)
  })
})

describe("tabsHoldSession", () => {
  test("finds a session or its routed child among a window's tabs", () => {
    const tabs = JSON.stringify([
      { type: "draft", draftID: "d", server: "sidecar", directory: "/x" },
      { type: "session", server: "sidecar", sessionId: "ses_parent", routeSessionId: session },
    ])

    expect(tabsHoldSession(tabs, session)).toBe(true)
    expect(tabsHoldSession(tabs, "ses_parent")).toBe(true)
    expect(tabsHoldSession(tabs, "ses_other")).toBe(false)
  })

  test("treats missing or corrupt tabs as holding nothing", () => {
    expect(tabsHoldSession(null, session)).toBe(false)
    expect(tabsHoldSession("not json", session)).toBe(false)
    expect(tabsHoldSession('{"sessionId":"x"}', session)).toBe(false)
  })
})
