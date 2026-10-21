export * as AttachmentReference from "./attachment-reference.js"

import type { FileAttachment } from "./prompt.js"

const prefix = "opencode-attachment:"

/** A list-only reference. Single-message reads always return the original attachment. */
export function is(file: FileAttachment) {
  return file.source.type === "uri" && file.source.uri.startsWith(prefix)
}

export function make(sessionID: string, messageID: string, index: number) {
  return `${prefix}${encodeURIComponent(sessionID)}/${encodeURIComponent(messageID)}/${index}`
}

export function parse(file: FileAttachment) {
  if (file.source.type !== "uri" || !file.source.uri.startsWith(prefix)) return
  const match = /^opencode-attachment:(ses_[^/]+)\/(msg_[^/]+)\/(0|[1-9]\d*)$/.exec(file.source.uri)

  const sessionID = match?.[1]
  const messageID = match?.[2]
  const index = match?.[3]

  if (!sessionID || !messageID || index === undefined || !Number.isSafeInteger(Number(index)))
    throw new Error("Invalid attachment reference")

  return { sessionID: decodeURIComponent(sessionID), messageID: decodeURIComponent(messageID), index: Number(index) }
}
