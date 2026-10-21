import { AttachmentReference } from "@opencode/client/attachment-reference"
import type { PromptFileAttachment, SessionMessageUser } from "@opencode/client/promise"
import type { ServerApi } from "./api"

/** Coalesce concurrent attachments of one message; mounted consumers own the resolved bytes. */
export function createAttachmentReader(api: () => ServerApi) {
  const pending = new Map<string, Promise<SessionMessageUser>>()

  return async (file: PromptFileAttachment) => {
    const reference = AttachmentReference.parse(file)

    if (!reference) return file
    const key = `${reference.sessionID}/${reference.messageID}`
    const request = pending.get(key) ?? api().session.message.get(reference).then((message) => {
      if (message?.type !== "user" || message.id !== reference.messageID)
        throw new Error("Original attachment message is unavailable")
      return message
    }).finally(() => pending.delete(key))
    pending.set(key, request)
    const original = (await request).files?.[reference.index]

    if (!original || AttachmentReference.is(original)) throw new Error("Original attachment is unavailable")

    return original
  }
}
