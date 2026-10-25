// PROTOTYPE (D-14): one transcript, three client views. Run with `bun script/transcript-prototype.ts`.
import type { SessionMessageAssistant } from "../src/promise"
import { apply, empty, type Change, type TranscriptEvent } from "../src/transcript.prototype"

const sessionID = "ses_demo"
const assistant = (content: SessionMessageAssistant["content"], finish?: SessionMessageAssistant["finish"]) => ({
  id: "msg_2",
  type: "assistant" as const,
  time: { created: 2 },
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content,
  finish,
})

const events: TranscriptEvent[] = [
  {
    type: "message.upserted",
    data: { sessionID, message: { id: "msg_1", type: "user", time: { created: 1 }, text: "list files" } },
  },
  { type: "message.upserted", data: { sessionID, message: assistant([{ type: "text", text: "" }]) } },
  { type: "part.delta", data: { sessionID, messageID: "msg_2", part: 0, field: "text", delta: "Looking" } },
  { type: "part.delta", data: { sessionID, messageID: "msg_2", part: 0, field: "text", delta: " now." } },
  {
    type: "message.upserted",
    data: {
      sessionID,
      message: assistant([
        { type: "text", text: "Looking now." },
        { type: "tool", id: "call_1", name: "glob", state: { status: "streaming", input: "" }, time: { created: 3 } },
      ]),
    },
  },
  { type: "part.delta", data: { sessionID, messageID: "msg_2", part: 1, field: "input", delta: '{"pattern":"*"}' } },
  {
    type: "message.upserted",
    data: {
      sessionID,
      message: assistant(
        [
          { type: "text", text: "Looking now." },
          {
            type: "tool",
            id: "call_1",
            name: "glob",
            state: { status: "completed", input: { pattern: "*" }, content: [{ type: "text", text: "a.ts\nb.ts" }] },
            time: { created: 3, completed: 4 },
          },
        ],
        "stop",
      ),
    },
  },
]

const transcript = empty()
const changes: Change[] = []
for (const event of events) {
  const change = apply(transcript, event)
  if (change) changes.push(change)
}

// App: the message list itself is the view.
console.log("app", transcript.messages.map((message) => message.type))
// TUI: one row per message, then one per visible part, then a footer for a finished turn.
console.log(
  "tui",
  transcript.messages.flatMap((message) =>
    message.type === "assistant"
      ? [
          ...message.content.map((part) => (part.type === "tool" ? `tool:${part.name}:${part.state.status}` : part.type)),
          ...(message.finish === "stop" ? ["footer"] : []),
        ]
      : [`message:${message.type}`],
  ),
)
// ACP: the stream of chunks, built only from the changes.
console.log(
  "acp",
  changes.flatMap((change) =>
    change.type === "appended"
      ? [`chunk:${JSON.stringify(change.delta)}`]
      : change.type === "updated"
        ? change.parts.map((part) => (part.type === "tool" ? `tool_call_update:${part.status}` : `part:${part.type}`))
        : [change.type],
  ),
)
