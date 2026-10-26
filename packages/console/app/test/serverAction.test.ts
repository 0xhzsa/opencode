import { describe, expect, test } from "bun:test"
import { sanitizeServerActionRequest } from "../src/lib/server-action"
import { newsletterEmail } from "../src/lib/newsletter"

describe("server action referer", () => {
  test("preserves same-origin return locations", () => {
    const request = new Request("https://dev.opencode.ai/_server?id=action", {
      headers: { referer: "https://dev.opencode.ai/auth?next=%2Fconsole" },
    })

    expect(sanitizeServerActionRequest(request)).toBe(request)
  })

  test("replaces unsafe return locations with the request origin", () => {
    const referers = ["https://evil.example/phishing-login", "not a url", undefined]

    expect(
      referers.map((referer) =>
        sanitizeServerActionRequest(
          new Request("https://dev.opencode.ai/_server?id=action", {
            headers: referer === undefined ? undefined : { referer },
          }),
        ).headers.get("referer"),
      ),
    ).toEqual(["https://dev.opencode.ai", "https://dev.opencode.ai", "https://dev.opencode.ai"])
  })

  test("does not change other routes", () => {
    const request = new Request("https://dev.opencode.ai/auth", {
      headers: { referer: "https://evil.example/phishing-login" },
    })

    expect(sanitizeServerActionRequest(request)).toBe(request)
  })
})

describe("newsletter email", () => {
  test("accepts and trims ordinary addresses", () => {
    expect(newsletterEmail("  fake-visitor+news@example.test ")).toBe("fake-visitor+news@example.test")
  })

  test("rejects malformed, non-ASCII and oversized addresses", () => {
    expect(
      [
        undefined,
        "",
        "fake-visitor",
        "fake@visitor@example.test",
        "fake visitor@example.test",
        "fake-visitor@example",
        "fake\u0000visitor@example.test",
        "fäke@example.test",
        `${"a".repeat(65)}@example.test`,
        `fake@${"a".repeat(250)}.test`,
      ].map(newsletterEmail),
    ).toEqual(Array(10).fill(undefined))
  })
})
