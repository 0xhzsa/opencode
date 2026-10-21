import { AttachmentReference } from "@opencode/client/attachment-reference"
import type { PromptFileAttachment, SessionMessageUser } from "@opencode/client/promise"
import type { ServerApi } from "./api"

/** One server's original user messages, shared by display, edit and fork; bounded by count and bytes. */
export function createAttachmentReader(read: ServerApi["session"]["message"]["get"]) {
  const pending = new Map<string, Promise<SessionMessageUser>>()
  const resolved = new Map<string, { message: SessionMessageUser; bytes: number }>()
  let bytes = 0

  const message = async (input: { sessionID: string; messageID: string }) => {
    const key = `${input.sessionID}/${input.messageID}`
    const cached = resolved.get(key)

    if (cached) {
      resolved.delete(key)
      resolved.set(key, cached)

      return cached.message
    }

    const request =
      pending.get(key) ??
      read(input)
        .then((message) => {
          if (message?.type !== "user" || message.id !== input.messageID || message.files?.some(AttachmentReference.is))
            throw new Error("Original attachment message is unavailable")
          // Count UTF-16 storage conservatively. Oversized originals may be shown but are not retained.
          const size = JSON.stringify(message).length * 2

          if (size <= 16 * 1024 * 1024) {
            resolved.set(key, { message, bytes: size })
            bytes += size

            while (resolved.size > 32 || bytes > 16 * 1024 * 1024) {
              const oldest = resolved.entries().next().value

              if (!oldest) break
              bytes -= oldest[1].bytes
              resolved.delete(oldest[0])
            }
          }

          return message
        })
        .finally(() => pending.delete(key))

    pending.set(key, request)

    return request
  }

  return {
    message,
    async file(file: PromptFileAttachment) {
      const reference = AttachmentReference.parse(file)

      if (!reference) return file
      const original = (await message(reference)).files?.[reference.index]

      if (!original || AttachmentReference.is(original)) throw new Error("Original attachment is unavailable")

      return original
    },
  }
}
