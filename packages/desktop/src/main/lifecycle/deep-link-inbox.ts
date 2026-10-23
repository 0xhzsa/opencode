import { app } from "electron"
import type { Event } from "electron"

const pending: string[] = []

const capture = (event: Event, url: string) => {
  event.preventDefault()
  pending.push(url)
}

const second = (_event: Event, argv: string[]) => pending.push(...argv.filter((arg) => arg.startsWith("opencode://")))

/** macOS delivers a cold-launch open-url before the main bundle has installed its lifecycle. */
export function captureInitialDeepLinks() {
  pending.push(...process.argv.filter((arg) => arg.startsWith("opencode://")))
  app.on("open-url", capture)
  app.on("second-instance", second)
}

export function takeInitialDeepLinks() {
  app.off("open-url", capture)
  app.off("second-instance", second)

  return pending.splice(0)
}
