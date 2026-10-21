import { createStore } from "solid-js/store"
import type { PromptFileAttachment, SessionMessageUser } from "@opencode/client/promise"
import { DataProvider } from "../context/data"
import { CurrentUserMessageDisplay } from "./message-content"

export default { title: "OpenCode/Conversation/Attachment hydration", id: "attachment-hydration" }

export const Deferred = {
  render: () => {
    const [state, setState] = createStore({ opened: "" })
    const message: SessionMessageUser = {
      id: "msg_files", type: "user", text: "Keep both attachments", time: { created: 1 },
      files: [
        { name: "pixel.png", mime: "image/png", data: "", source: { type: "uri", uri: "opencode-attachment:ses_files/msg_files/0" } },
        { name: "note.txt", mime: "text/plain", data: "", source: { type: "uri", uri: "opencode-attachment:ses_files/msg_files/1" } },
      ],
    }
    return (
      <DataProvider
        data={{ session: [], session_status: {}, session_diff: {} }} directory="/fixture"
        readAttachment={async (file): Promise<PromptFileAttachment> => {
          const response = await fetch(`/attachment-fixture/${file.name}`)
          if (!response.ok) throw new Error("Fixture request failed")
          return response.json()
        }}
      >
        <output aria-label="Opened attachment">{state.opened}</output>
        <CurrentUserMessageDisplay
          sessionID="ses_files" message={message} text={message.text} agent="build"
          model={{ providerID: "test", id: "test" }}
          actions={{ openAttachment: (file) => { setState("opened", `${file.name}:${file.data}`) } }}
        />
      </DataProvider>
    )
  },
}
