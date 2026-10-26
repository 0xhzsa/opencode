import {
  activePermissionRequest,
  activeQuestionRequest,
  attachmentsAndCommentsDocument,
  compactionDocument,
  editThenTestDocument,
  emptySessionDocument,
  largeCompletedDocument,
  permissionPendingDocument,
  questionPendingDocument,
  retryDocument,
  streamingDocument,
  STORY_TIME,
  subagentDocument,
  terminalPassedDocument,
} from "@opencode/session-ui/storybook"
import { SessionPreview } from "./story-model"

const description = "opencode · modular-session-ui"

const retryAfterInterruption = {
  ...retryDocument,
  messages: [
    ...compactionDocument.messages,
    ...retryDocument.messages.map((message, index) => {
      const created = STORY_TIME + 70_000 + index * 1_000

      if (message.type !== "assistant" || !message.retry) {
        return { ...message, time: { ...message.time, created } }
      }

      return {
        ...message,
        time: { ...message.time, created },
        retry: { ...message.retry, at: created },
      }
    }),
  ],
}

const implementAndVerify = () => (
  <SessionPreview
    title="Update active Session status"
    description={description}
    document={editThenTestDocument}
    draft="Add a browser assertion for the updated status"
  />
)

export default {
  title: "OpenCode/Session/Complete workspace",
  id: "app-current-session-surface",
  component: SessionPreview,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "A server-free Session workbench for product and design review. It composes the production current timeline, titlebar actions, Composer, request docks, and review components.",
      },
    },
  },
}

export const ImplementAndVerifyLight = {
  globals: { theme: "light" },
  render: implementAndVerify,
}

export const ImplementAndVerifyDark = {
  globals: { theme: "dark" },
  render: implementAndVerify,
}

export const WorkFromAttachments = {
  render: () => (
    <SessionPreview
      title="Fix narrow Session spacing"
      description={description}
      document={attachmentsAndCommentsDocument}
      draft="Verify the same layout at 360 px"
    />
  ),
}

export const LongRunningSession = {
  render: () => (
    <SessionPreview
      title="Modularize Session rendering"
      description={description}
      document={largeCompletedDocument}
      draft="Summarize the remaining verification"
    />
  ),
}

export const MixedDirectionRtl = {
  globals: { theme: "dark", direction: "rtl" },
  render: () => (
    <SessionPreview
      title="مراجعة واجهة Session"
      description="opencode · packages/app/src/session/screen.tsx"
      document={attachmentsAndCommentsDocument}
      draft="راجع المسار packages/app/src/session/screen.tsx ثم شغّل bun test"
    />
  ),
}

export const EmptySession = {
  render: () => <SessionPreview title="New Session" description={description} document={emptySessionDocument} />,
}

export const StreamingSession = {
  render: () => (
    <SessionPreview title="Stream the Session response" description={description} document={streamingDocument} />
  ),
}

export const EditThenShellTest = {
  render: implementAndVerify,
}

export const PermissionRequest = {
  render: () => (
    <SessionPreview
      title="Publish canary preview"
      description={description}
      document={permissionPendingDocument}
      request={{ type: "permission", value: activePermissionRequest }}
    />
  ),
}

export const QuestionRequest = {
  render: () => (
    <SessionPreview
      title="Add the Session review panel"
      description={description}
      document={questionPendingDocument}
      request={{ type: "question", value: activeQuestionRequest }}
    />
  ),
}

export const QuestionAnswerCounts = {
  render: () => (
    <SessionPreview
      title="Choose supporting surfaces"
      description={description}
      document={questionPendingDocument}
      request={{
        type: "question",
        value: {
          ...activeQuestionRequest,
          fields: [
            activeQuestionRequest.fields[0],
            {
              ...activeQuestionRequest.fields[1],
              options: [...activeQuestionRequest.fields[1].options, { value: "diagnostics", label: "Diagnostics" }],
            },
          ],
        },
      }}
    />
  ),
}

export const QuestionMultiSelect = {
  render: () => (
    <SessionPreview
      title="Choose supporting surfaces"
      description={description}
      document={questionPendingDocument}
      request={{ type: "question", value: { ...activeQuestionRequest, fields: [activeQuestionRequest.fields[1]] } }}
    />
  ),
}

// A pick-any question with more answers than the dock has room for, then a short one.
export const QuestionLongList = {
  render: () => (
    <SessionPreview
      title="Polish the docs site"
      description="opencode · docs"
      document={questionPendingDocument}
      request={{
        type: "question",
        value: {
          ...activeQuestionRequest,
          fields: [
            {
              key: "details",
              type: "multiselect",
              title: "Details",
              description: "Which should the builder add next? Pick any.",
              options: [
                {
                  value: "typography",
                  label: "All typography (Recommended)",
                  description:
                    "Hanging punctuation, tabular figures, typesetting fixes, one label style, accent selection",
                },
                { value: "links", label: "Heading links", description: "Hover shows #, click copies the section link" },
                {
                  value: "contents",
                  label: "Sticky contents list",
                  description: "Section list in the margin on wide screens, highlights where you are",
                },
                { value: "sidenotes", label: "Sidenotes", description: "Margin notes on desktop, inline on phone" },
                { value: "glossary", label: "Glossary terms", description: "Dotted underline, definition on hover" },
                { value: "fade", label: "Scroll fade", description: "Fade the edge of anything that scrolls sideways" },
                { value: "code", label: "Highlighted code lines", description: "Tint the lines that matter" },
                { value: "verdict", label: "Verdict line", description: "Answer or decision first, in the header" },
                {
                  value: "checked",
                  label: "Checked / not checked",
                  description: "Marker for verified vs unverified claims",
                },
                {
                  value: "diagram",
                  label: "Diagram interaction",
                  description: "Hover highlights connections, click enlarges",
                },
                { value: "footer", label: "Footer", description: "Source path to copy, plus the date it was made" },
              ],
            },
            {
              key: "ship",
              type: "string",
              title: "Ship",
              description: "Ship them in one pull request?",
              options: [
                { value: "one", label: "One pull request" },
                { value: "split", label: "One per detail" },
              ],
            },
          ],
        },
      }}
    />
  ),
}

export const McpElicitationRequest = {
  render: () => (
    <SessionPreview
      title="Publish the release"
      description={description}
      document={questionPendingDocument}
      request={{
        type: "elicitation",
        value: {
          id: "frm_elicitation_preview",
          sessionID: "global",
          title: "release is requesting input",
          metadata: { kind: "mcp-elicitation", server: "release", message: "Publish v2.4.0 to the selected channel?" },
          fields: [
            { key: "approve", type: "boolean", title: "Approve publish", required: true },
            {
              key: "channel",
              type: "string",
              title: "Channel",
              options: [
                { value: "beta", label: "Beta" },
                { value: "latest", label: "Latest" },
              ],
            },
            { key: "notes", type: "string", title: "Release notes", placeholder: "Optional summary" },
            { key: "retries", type: "integer", title: "Retries", minimum: 0, default: 2 },
          ],
        },
      }}
    />
  ),
}

export const McpUrlElicitationRequest = {
  render: () => (
    <SessionPreview
      title="Authorize the deployment"
      description={description}
      document={questionPendingDocument}
      request={{
        type: "elicitation",
        value: {
          id: "frm_url_elicitation_preview",
          sessionID: "global",
          title: "deploy is requesting input",
          metadata: { kind: "mcp-elicitation", server: "deploy", message: "Authorize access to your account" },
          fields: [{ key: "elicitation", type: "external", url: "https://example.com/authorize" }],
        },
      }}
    />
  ),
}

export const WebSearchRequest = {
  render: () => (
    <SessionPreview
      title="Search for current documentation"
      description={description}
      document={questionPendingDocument}
      request={{
        type: "websearch",
        value: {
          id: "frm_websearch_preview",
          sessionID: "ses_websearch_preview",
          title: "Web Search",
          metadata: { kind: "websearch.provider" },
          fields: [{ key: "choice", type: "string", required: true, custom: false }],
        },
      }}
    />
  ),
}

export const RetryAndInterruption = {
  render: () => (
    <SessionPreview title="Recover the interrupted run" description={description} document={retryAfterInterruption} />
  ),
}

export const ReviewPlusTerminal = {
  render: () => (
    <SessionPreview
      title="Review the terminal verification"
      description={description}
      document={{ ...terminalPassedDocument, diffs: editThenTestDocument.diffs }}
      reviewOpened
    />
  ),
}

export const ChildSession = {
  render: () => (
    <SessionPreview
      title="Inspect the child Session"
      description={description}
      document={subagentDocument}
      child={{
        agent: "surveyor",
        model: { provider: "Anthropic", name: "Claude Opus 5.5", variant: "high" },
        status: "running",
        started: Date.now() - 65_000,
      }}
    />
  ),
}

export const ChildSessionDone = {
  render: () => (
    <SessionPreview
      title="Inspect a finished child Session"
      description={description}
      document={subagentDocument}
      child={{
        agent: "surveyor",
        model: { provider: "Anthropic", name: "Claude Opus 5.5", variant: "high" },
        status: "succeeded",
        started: 0,
        ended: 252_000,
      }}
    />
  ),
}

export const MobileLayout = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: () => (
    <SessionPreview
      title="Review the mobile Session"
      description={description}
      document={attachmentsAndCommentsDocument}
    />
  ),
}

export const NarrowLayout = {
  globals: { viewport: { value: "tablet", isRotated: false } },
  parameters: { viewport: { defaultViewport: "tablet" } },
  render: () => (
    <SessionPreview
      title="Review the narrow Session"
      description={description}
      document={editThenTestDocument}
      reviewOpened
    />
  ),
}
