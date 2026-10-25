// PROTOTYPE (D-14, "One Client Reducer, Resumable SSE"). Throwaway; lives on proto/client-reducer only.
//
// The one piece every client shares: wire events -> messages and parts. The server already projects
// every durable session event into a message (core/session/message-updater.ts), so instead of each
// client re-deriving that projection from ~40 `session.*` event types, the server ships the projected
// message and clients only upsert it. Live-only fragments (text, reasoning, tool input, compaction
// summary) arrive as `part.delta` and are appended in place.
//
// What stays per client is everything after this module: the app's timeline, the TUI's rows, the mini
// TUI's scrollback commits and ACP's SessionUpdate chunks are all derived from `Transcript` + `Change`.
//
// Found while building this: two kinds are not quite enough. A committed revert deletes messages, so
// there is a third kind, `message.removed`.

import type { SessionMessageAssistant, SessionMessageAssistantTool, SessionMessageInfo } from "./promise"

export type MessageUpserted = {
  readonly type: "message.upserted"
  readonly data: { readonly sessionID: string; readonly message: SessionMessageInfo }
}

export type PartDelta = {
  readonly type: "part.delta"
  readonly data: {
    readonly sessionID: string
    readonly messageID: string
    /** Index into `assistant.content`; absent for a running compaction's summary. */
    readonly part?: number
    readonly field: "text" | "input" | "summary"
    readonly delta: string
  }
}

export type MessageRemoved = {
  readonly type: "message.removed"
  /** Removes `from` and every message after it, which is what a committed revert does. */
  readonly data: { readonly sessionID: string; readonly from: string }
}

export type TranscriptEvent = MessageUpserted | PartDelta | MessageRemoved

export type Transcript = {
  readonly messages: SessionMessageInfo[]
  readonly index: Map<string, number>
}

/** What one event changed, so delta-shaped views (scrollback, ACP) don't have to diff whole messages. */
export type Change =
  | { readonly type: "inserted"; readonly message: SessionMessageInfo }
  | {
      readonly type: "updated"
      readonly message: SessionMessageInfo
      readonly previous: SessionMessageInfo
      readonly parts: ReadonlyArray<PartChange>
    }
  | { readonly type: "appended"; readonly messageID: string; readonly part?: number; readonly delta: string }
  | { readonly type: "removed"; readonly messageIDs: ReadonlyArray<string> }

export type PartChange =
  | { readonly type: "added"; readonly part: number }
  | { readonly type: "grew"; readonly part: number; readonly tail: string }
  | { readonly type: "tool"; readonly part: number; readonly status: SessionMessageAssistantTool["state"]["status"] }

export function empty(): Transcript {
  return { messages: [], index: new Map() }
}

export function load(messages: ReadonlyArray<SessionMessageInfo>): Transcript {
  return { messages: [...messages], index: new Map(messages.map((message, position) => [message.id, position])) }
}

/** Mutates in place so it runs unchanged inside a Solid `produce` draft or on a plain array. */
export function apply(transcript: Transcript, event: TranscriptEvent): Change | undefined {
  const { messages, index } = transcript
  switch (event.type) {
    case "message.upserted": {
      const message = event.data.message
      const position = index.get(message.id)
      if (position === undefined) {
        index.set(message.id, messages.length)
        messages.push(message)
        return { type: "inserted", message }
      }
      const previous = messages[position]!
      messages[position] = message
      return { type: "updated", message, previous, parts: diffParts(previous, message) }
    }
    case "part.delta": {
      const position = index.get(event.data.messageID)
      const message = position === undefined ? undefined : messages[position]
      if (!message) return
      if (event.data.field === "summary") {
        if (message.type !== "compaction" || message.status !== "running") return
        message.summary += event.data.delta
        return { type: "appended", messageID: message.id, delta: event.data.delta }
      }
      const part = message.type === "assistant" ? message.content[event.data.part ?? -1] : undefined
      if (!part) return
      if (event.data.field === "text" && part.type !== "tool") part.text += event.data.delta
      else if (event.data.field === "input" && part.type === "tool" && part.state.status === "streaming")
        part.state.input += event.data.delta
      else return
      return { type: "appended", messageID: message.id, part: event.data.part, delta: event.data.delta }
    }
    case "message.removed": {
      const position = index.get(event.data.from)
      if (position === undefined) return
      const removed = messages.splice(position).map((message) => message.id)
      for (const id of removed) index.delete(id)
      return { type: "removed", messageIDs: removed }
    }
  }
}

function diffParts(previous: SessionMessageInfo, next: SessionMessageInfo): PartChange[] {
  if (next.type !== "assistant") return []
  const before: SessionMessageAssistant["content"] = previous.type === "assistant" ? previous.content : []
  return next.content.flatMap((part, position): PartChange[] => {
    const old = before[position]
    if (!old || old.type !== part.type) return [{ type: "added", part: position }]
    if (part.type === "tool")
      return old.type === "tool" && old.state.status !== part.state.status
        ? [{ type: "tool", part: position, status: part.state.status }]
        : []
    if (old.type === "tool" || part.text.length <= old.text.length) return []
    return [{ type: "grew", part: position, tail: part.text.slice(old.text.length) }]
  })
}
