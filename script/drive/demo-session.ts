import { readFileSync } from "node:fs"
import { Effect, Stream } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"

// Serves the debug bar's Demo controls: an isolated server whose simulated model answers each `[demo:<action> <speed>×]`
// prompt with a scripted reply. Shell, edit, read and subagent calls run for real inside the throwaway project.
// Run from the repository root with `opencode-drive run script/drive/demo-session.ts`; see demo-session.md.
const state = process.env.DEMO_STATE

const tides = [
  "#!/bin/sh",
  'delay=$(awk "BEGIN { print 0.22 / ${1:-1} }")',
  "for station in Breakwater 'North Mole' 'Lantern Quay' 'Saltmarsh Gate' 'Pilot Steps' 'Fishery Slip' 'East Buoy' 'Harbor Mouth'; do",
  '  printf "✓ %-16s high water within 4 cm\\n" "$station"',
  '  sleep "$delay"',
  "done",
  'printf "\\n8 passed, 0 failed\\n"',
].join("\n")

const preview = [
  "#!/bin/sh",
  'delay=$(awk "BEGIN { print 0.9 / ${1:-1} }")',
  'printf "Lantern preview starting on http://127.0.0.1:4173\\n"',
  "for frame in 1 2 3 4 5 6 7 8 9 10 11 12; do",
  '  sleep "$delay"',
  '  printf "rebuilt beacon map (%s/12)\\n" "$frame"',
  "done",
  'printf "preview idle\\n"',
].join("\n")

const harbor = [
  "export const lantern = {",
  '  name: "North Mole",',
  "  intervalMs: 4000,",
  '  color: "amber",',
  "}",
  "",
  "export function nextFlash(at: number) {",
  "  return at + lantern.intervalMs",
  "}",
  "",
].join("\n")

const paragraph =
  "The harbor wakes before the town does. Fishing boats slip their moorings while the lanterns along the North Mole " +
  "are still turning, and the tide tables pinned inside the pilot's hut are already out of date by a few minutes. " +
  "Most mornings the fog lifts in layers: first the masts, then the roofs of the net sheds, and finally the long " +
  "breakwater, which always seems farther away than it is. By the time the bakery opens, the first catch is on ice."

const code = [
  "Here is the scheduler that keeps the lanterns in phase:",
  "",
  "```ts",
  "type Lantern = { name: string; intervalMs: number; offsetMs: number }",
  "",
  "export function schedule(lanterns: Lantern[], now: number) {",
  "  return lanterns",
  "    .map((lantern) => {",
  "      const elapsed = (now - lantern.offsetMs) % lantern.intervalMs",
  "      return { name: lantern.name, nextFlash: now + lantern.intervalMs - elapsed }",
  "    })",
  "    .toSorted((a, b) => a.nextFlash - b.nextFlash)",
  "}",
  "",
  "export function inPhase(a: Lantern, b: Lantern) {",
  "  return a.intervalMs === b.intervalMs && a.offsetMs === b.offsetMs",
  "}",
  "```",
  "",
  "Each lantern keeps its own interval, so the sort decides which one flashes next.",
].join("\n")

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV ?? process.cwd() },
    tui: { viewport: { cols: 100, rows: 30 } },
    llm: { requestTimeout: 3_600_000, settlementTimeout: 5_000 },
    config: {
      autoupdate: false,
      username: "Demo",
      agents: { surveyor: { mode: "subagent", description: "Surveys a part of the harbor" } },
    },
    project: {
      git: true,
      files: {
        "README.md": "# Harbor\nLantern schedules and tide checks for a fictional harbor.\n",
        "src/harbor.ts": harbor,
        "src/tides.ts": "export const stations = ['Breakwater', 'North Mole', 'Lantern Quay']\n",
        "src/fleet.ts": "export const boats = ['Gannet', 'Kittiwake', 'Shearwater']\n",
        "docs/pilots.md": "# Pilot steps\nBoard at the pilot steps two hours before high water.\n",
        "scripts/tides.sh": tides,
        "scripts/preview.sh": preview,
      },
    },
  },
  ({ llm, artifacts, directory }) =>
    Effect.gen(function* () {
      yield* llm.title(() => Effect.succeed("Timeline demo"))
      yield* llm.serve((request) => {
        const body = JSON.stringify(request.body)
        if (body.includes("You are a subagent spawned")) return child(rate(body))
        const turn = demoTurn(request.body)
        if (!turn) return reply("Noted. The harbor log is up to date.", 1)
        return respond(turn.action, turn.step, turn.speed, directory)
      })
      const session = yield* Effect.promise(() => createSession(artifacts, directory))
      console.log(`Demo session ${session.id} in ${directory}`)
      if (state)
        yield* Effect.promise(() => Bun.write(state, JSON.stringify({ ...session.server, session: session.id })))
      return yield* Effect.never
    }),
)

function respond(action: string, step: number, speed: number, directory: string) {
  const call = (name: string, input: Record<string, string | boolean>, index = 0) =>
    Llm.toolCall({ index, id: `call_${crypto.randomUUID().replaceAll("-", "")}`, name, input })
  const text = (value: string, chunk = 3) => Llm.text(value, { delay: 16 / speed, chunkSize: chunk })
  const think = (value: string) => Llm.reasoning(value, { delay: 24 / speed, chunkSize: 4 })
  const tools = (...outputs: Llm.Output[]) => Stream.make(...outputs, Llm.finish("tool-calls"))

  switch (action) {
    case "paragraph":
      return Stream.make(think("Describing the morning harbor."), text(paragraph))
    case "code":
      return Stream.make(text(code, 6))
    case "shell":
      if (step === 0)
        return tools(
          text("Running the tide checks."),
          call("shell", {
            command: `sh scripts/tides.sh ${speed}`,
            description: "Run tide checks",
            workdir: directory,
          }),
        )
      return Stream.make(text("All eight stations are within tolerance."))
    case "patch":
      if (step === 0)
        return tools(text("Retiming the North Mole lantern."), call("patch", { patchText: patch(directory) }))
      return Stream.make(text("The lantern interval is updated."))
    case "turn":
      return Stream.make(
        think(
          "Checking the tide tables against the lantern schedule. The North Mole runs on a four second interval, " +
            "the Lantern Quay on six, so they line up every twelve seconds. High water is at 06:40, which means " +
            "the pilot boat leaves at 04:40 and needs both lanterns in phase before then.",
        ),
        Llm.pause(1_500 / speed),
        text("Both lanterns are in phase before the pilot boat leaves."),
      )
    case "message":
      return Stream.make(text("Sure. The harbor is quiet today."))
    case "steer":
      return Stream.make(text("Got it, I'll include the tide tables as well."))
    case "burst":
      if (step === 0)
        return tools(
          Llm.text("Reading the harbor files.", { delay: 4 / speed, chunkSize: 2 }),
          ...["README.md", "src/harbor.ts", "src/tides.ts", "src/fleet.ts", "docs/pilots.md"].map((file, index) =>
            call("read", { path: `${directory}/${file}` }, index),
          ),
        )
      return Stream.make(
        Llm.text(
          "Five files: the lantern config, the tide stations, the fleet roster, the pilot notes and the readme.",
          { delay: 4 / speed, chunkSize: 1 },
        ),
      )
    case "queue":
      return Stream.make(text("Next on the list: repaint the pilot steps before the spring tides."))
    case "subagent":
      if (step === 0)
        return tools(
          text("Sending a surveyor to the breakwater."),
          call("subagent", {
            agent: "surveyor",
            description: "Survey the breakwater",
            prompt: `[demo:child ${speed}×] Walk the breakwater and report any loose stones.`,
            background: true,
          }),
        )
      return Stream.make(text("The survey runs in the background. I'll report back when it lands."))
    case "background":
      if (step === 0)
        return tools(
          text("Starting the lantern preview."),
          call("shell", {
            command: `sh scripts/preview.sh ${speed}`,
            description: "Lantern preview",
            workdir: directory,
            background: true,
          }),
        )
      return Stream.make(text("The preview is starting in the background."))
  }
  return reply("Noted.", speed)
}

function child(speed: number) {
  return Stream.make(
    Llm.reasoning("Walking the breakwater from the harbor mouth.", { delay: 30 / speed, chunkSize: 3 }),
    Llm.pause(1_200 / speed),
    Llm.text(
      "The breakwater is sound. Two capstones near the East Buoy have shifted a few centimetres and should be reset " +
        "at the next low spring tide.",
      { delay: 40 / speed, chunkSize: 3 },
    ),
  )
}

function reply(value: string, speed: number) {
  return Stream.make(Llm.text(value, { delay: 16 / speed, chunkSize: 3 }))
}

// Toggles the lantern interval, so every press produces a real diff.
function patch(directory: string) {
  const path = `${directory}/src/harbor.ts`
  const [from, to] = readFileSync(path, "utf8").includes("intervalMs: 6000") ? [6000, 4000] : [4000, 6000]
  return [
    "*** Begin Patch",
    `*** Update File: ${path}`,
    "@@",
    `-  intervalMs: ${from},`,
    `+  intervalMs: ${to},`,
    "*** End Patch",
  ].join("\n")
}

function rate(body: string) {
  const match = body.match(/\[demo:[a-z]+ ([\d.]+)×\]/)
  return match ? Number(match[1]) || 1 : 1
}

// The newest user message picks the action; assistant messages after it count the steps already taken this turn.
function demoTurn(body: unknown) {
  const messages = typeof body === "object" && body !== null && "messages" in body ? body.messages : undefined
  if (!Array.isArray(messages)) return
  const last = messages.findLastIndex((message) => message?.role === "user")
  if (last < 0) return
  const match = JSON.stringify(messages[last]).match(/\[demo:([a-z]+) ([\d.]+)×\]/)
  if (!match) return
  return {
    action: match[1],
    speed: Number(match[2]) || 1,
    step: messages.slice(last + 1).filter((message) => message?.role === "assistant").length,
  }
}

// Drive's SDK client trails the server protocol, so the session is created over plain HTTP with the isolated
// server's own registration.
async function createSession(artifacts: string, directory: string) {
  const registration: { url: string; password?: string } = await Bun.file(
    `${artifacts}/home/.local/state/opencode/service-local.json`,
  ).json()
  const headers = {
    "content-type": "application/json",
    ...(registration.password ? { authorization: `Basic ${btoa(`opencode:${registration.password}`)}` } : {}),
  }
  const response = await fetch(`${registration.url}/api/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Timeline demo", location: { directory } }),
  })
  const created = (await response.json()) as { data: { id: string } }
  return { id: created.data.id, server: registration }
}
