export * as CacheProbe from "./cache-probe.js"

import type { ContentPart, LLMRequest, Message, ToolEntry } from "@opencode/ai"
import type { TokenUsage } from "@opencode/schema/token-usage"
import { Hash } from "@opencode/util/hash"

/** Anthropic's default prompt-cache lifetime; OpenAI keeps prefixes about as long. */
export const CACHE_TTL_MS = 5 * 60 * 1000
/** OpenAI caches in 1,024-token blocks, so smaller drops are bucket jitter. */
export const MISS_FLOOR = 1024
const MAX_SESSIONS = 256
const MAX_TOOL_NAMES = 5

export type Request = Pick<
  LLMRequest,
  "system" | "messages" | "tools" | "toolChoice" | "providerOptions" | "promptCacheKey"
>

interface MessagePrint {
  readonly key: string | undefined
  readonly role: string
  /** Cheap structural summary; a message whose key and signature match the previous step reuses its hash. */
  readonly signature: string
  readonly hash: string
  readonly media: number
  readonly checkpoint: boolean
}

/** Hashes of each request segment, in the order providers build their cached prefix. */
export interface Fingerprint {
  readonly at: number
  readonly model: string
  readonly options: Readonly<Record<string, string>>
  readonly tools: ReadonlyArray<readonly [name: string, hash: string]>
  readonly system: ReadonlyArray<string>
  readonly messages: ReadonlyArray<MessagePrint>
}

export type Reason =
  | "model-switch"
  | "options-changed"
  | "tools-changed"
  | "instructions-changed"
  | "compaction"
  | "history-rewritten"
  | "idle-ttl"
  | "provider-eviction"

export interface Change {
  readonly reason: Reason
  readonly detail?: string
}

export interface Miss extends Change {
  readonly missed: number
  readonly idle?: string
}

// Cache hints only steer breakpoints and metadata never reaches the provider, so neither affects the cached prefix.
const replacer = (key: string, value: unknown) => {
  if (key === "cache" || key === "metadata") return undefined
  if (value instanceof Uint8Array) return Hash.fast(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
  return value
}
const hash = (value: unknown) => Hash.fast(JSON.stringify(value, replacer) ?? "")

const size = (value: unknown) => {
  if (typeof value === "string") return value.length
  if (Array.isArray(value)) return value.length
  if (value && typeof value === "object") return Object.keys(value).length
  return 0
}

const mediaSize = (part: Extract<ContentPart, { type: "media" }>) => {
  const source = part.media.source
  if (source.type === "base64") return source.data.length
  if (source.type === "bytes") return source.data.byteLength
  if (source.type === "url") return source.url.length
  return source.id.length
}

const partSignature = (part: ContentPart): string => {
  const meta = part.type !== "effort" && "providerMetadata" in part && part.providerMetadata ? "+" : ""
  switch (part.type) {
    case "text":
      return `t${part.text.length}${meta}`
    case "reasoning":
      return `r${part.text.length}:${part.encrypted?.length ?? 0}${meta}`
    case "media":
      return `m${part.media.mediaType}:${mediaSize(part)}${meta}`
    case "tool-call":
      return `c${part.id}:${size(part.input)}${meta}`
    case "tool-result":
      return `o${part.id}:${part.result.type}:${size(part.result.value)}${meta}`
    case "compaction":
      return `k${part.encrypted?.length ?? part.text?.length ?? 0}`
    case "effort":
      return `e${part.effort}:${part.previous}`
  }
}

// Tool results carry no message id, but their call id is unique within the session.
const messageKey = (message: Message) => message.id ?? message.content.find((part) => part.type === "tool-result")?.id

const isCheckpoint = (message: Message) =>
  message.content.some(
    (part) => part.type === "compaction" || (part.type === "text" && part.text.startsWith("<conversation-checkpoint>")),
  )

const printMessage = (message: Message, memo: Map<string, MessagePrint>): MessagePrint => {
  const key = messageKey(message)
  const signature = message.role + "|" + message.content.map(partSignature).join("|")
  const cached = key === undefined ? undefined : memo.get(key)
  if (cached && cached.signature === signature) return cached
  return {
    key,
    role: message.role,
    signature,
    hash: hash(message),
    media: message.content.filter((part) => part.type === "media").length,
    checkpoint: isCheckpoint(message),
  }
}

const toolPrint = (tool: ToolEntry): readonly [string, string] =>
  tool.type === "namespace"
    ? [tool.name, hash([tool.description, tool.tools])]
    : [tool.name, hash([tool.description, tool.inputSchema, tool.outputSchema, tool.native])]

/** Fingerprints a request. Messages unchanged since `previous` reuse its hashes, so each step hashes only new history. */
export const fingerprint = (
  input: { readonly request: Request; readonly model: string; readonly at: number },
  previous?: Fingerprint,
): Fingerprint => {
  const memo = new Map<string, MessagePrint>()
  for (const message of previous?.messages ?? []) if (message.key !== undefined) memo.set(message.key, message)
  const request = input.request
  return {
    at: input.at,
    model: input.model,
    // Sampling and output limits (`generation`) don't key the cache; maxTokens changes every step.
    options: {
      toolChoice: hash(request.toolChoice),
      providerOptions: hash(request.providerOptions),
      promptCacheKey: request.promptCacheKey ?? "",
    },
    tools: request.tools.map(toolPrint),
    system: request.system.map((part) => Hash.fast(part.text)),
    messages: request.messages.map((message) => printMessage(message, memo)),
  }
}

/** Tokens the previous prompt made cacheable that this step did not read back. */
export const missed = (previous: TokenUsage.Info, current: TokenUsage.Info) =>
  previous.input + previous.cache.read + previous.cache.write - current.cache.read

const names = (list: ReadonlyArray<string>) =>
  list.length > MAX_TOOL_NAMES
    ? [...list.slice(0, MAX_TOOL_NAMES), `…+${list.length - MAX_TOOL_NAMES}`].join(" ")
    : list.join(" ")

const toolChange = (previous: Fingerprint, current: Fingerprint): Change | undefined => {
  if (
    previous.tools.length === current.tools.length &&
    previous.tools.every(
      ([name, hash], index) => current.tools[index]![0] === name && current.tools[index]![1] === hash,
    )
  )
    return
  const before = new Map(previous.tools)
  const after = new Map(current.tools)
  const added = current.tools.filter(([name]) => !before.has(name)).map(([name]) => `+${name}`)
  const removed = previous.tools.filter(([name]) => !after.has(name)).map(([name]) => `-${name}`)
  const changed = current.tools
    .filter(([name, hash]) => before.has(name) && before.get(name) !== hash)
    .map(([name]) => `~${name}`)
  const detail = [...added, ...removed, ...changed]
  return { reason: "tools-changed", detail: detail.length > 0 ? names(detail) : "reordered" }
}

const messageChange = (previous: Fingerprint, current: Fingerprint): Change | undefined => {
  const index = previous.messages.findIndex((message, index) => current.messages[index]?.hash !== message.hash)
  if (index === -1) return
  const before = previous.messages[index]!
  const after = current.messages[index]
  if (after?.checkpoint)
    return {
      reason: "compaction",
      detail: `messages ${previous.messages.length}→${current.messages.length}`,
    }
  const why =
    after === undefined
      ? "truncated"
      : before.media > after.media
        ? "media-removed"
        : before.key !== after.key
          ? "replaced"
          : "edited"
  return { reason: "history-rewritten", detail: `messages[${index}] ${before.role} ${why}` }
}

/** The first prefix segment that differs between two consecutive requests, in provider cache order. */
export const firstChange = (previous: Fingerprint, current: Fingerprint): Change | undefined => {
  if (previous.model !== current.model) return { reason: "model-switch", detail: `${previous.model}→${current.model}` }
  const options = Object.keys(current.options).filter((key) => previous.options[key] !== current.options[key])
  if (options.length > 0) return { reason: "options-changed", detail: options.join(",") }
  const tools = toolChange(previous, current)
  if (tools) return tools
  const system = Math.max(previous.system.length, current.system.length)
  for (let index = 0; index < system; index++)
    if (previous.system[index] !== current.system[index])
      return { reason: "instructions-changed", detail: `system[${index}]` }
  return messageChange(previous, current)
}

const duration = (ms: number) => {
  const seconds = Math.round(ms / 1000)
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : `${seconds}s`
}

export interface Step {
  readonly print: Fingerprint
  readonly usage: TokenUsage.Info
}

/** Names why `current` missed the cache `previous` left behind, or undefined when it did not miss. */
export const diagnose = (previous: Step, current: Step): Miss | undefined => {
  const lost = missed(previous.usage, current.usage)
  if (lost <= MISS_FLOOR) return
  const gap = current.print.at - previous.print.at
  const idle = gap > CACHE_TTL_MS ? duration(gap) : undefined
  const change = firstChange(previous.print, current.print)
  return {
    missed: lost,
    ...(change ?? { reason: idle ? "idle-ttl" : "provider-eviction" }),
    ...(idle ? { idle } : {}),
  }
}

interface Entry extends Step {
  /** Whether the provider ever reported cache activity; providers without caching never miss. */
  readonly cached: boolean
}

/** Last settled request per session, bounded to the most recently active sessions. */
export class Tracker {
  readonly #entries = new Map<string, Entry>()

  observe(sessionID: string, input: Parameters<typeof fingerprint>[0]): Fingerprint | undefined {
    try {
      return fingerprint(input, this.#entries.get(sessionID)?.print)
    } catch {
      return undefined
    }
  }

  settle(sessionID: string, print: Fingerprint, usage: TokenUsage.Info): Miss | undefined {
    const previous = this.#entries.get(sessionID)
    const cached = (previous?.cached ?? false) || usage.cache.read > 0 || usage.cache.write > 0
    this.#entries.delete(sessionID)
    this.#entries.set(sessionID, { print, usage, cached })
    if (this.#entries.size > MAX_SESSIONS) this.#entries.delete(this.#entries.keys().next().value!)
    if (!previous || !cached) return
    try {
      return diagnose(previous, { print, usage })
    } catch {
      return undefined
    }
  }

  delete(sessionID: string) {
    this.#entries.delete(sessionID)
  }

  get size() {
    return this.#entries.size
  }
}
