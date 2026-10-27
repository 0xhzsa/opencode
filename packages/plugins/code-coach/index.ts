import { Plugin } from "@opencode/plugin"
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Code Coach - opencode plumbing lane.
 *
 * opencode v2 exposes `session.hook("prompt")` before the model request and
 * `session.hook("context")` immediately before dispatch. The coach sits in that
 * doorway:
 *   1. build a compact context digest from the session (files, errors, checks,
 *      constraints, success criteria, prior goals, repeat count) and the active
 *      workspace;
 *   2. drop `req-<id>.json` with the prompt, the digest, cwd, and session id;
 *   3. the daemon answers `hold` (a destructive ask with no recovery point),
 *      `attach` (a change ask that names no target), or `pass`;
 *   4. on hold one card offers the guardrail or the original words;
 *   5. on attach this hook stores the context for the next model call and the
 *      `context` hook pushes it as an extra system block. `prompt.text` is
 *      never mutated: the developer's submitted words stay exactly as typed.
 *
 * The digest is facts, not a transcript: bounded snippets, paths, and counts.
 * The trace never stores draft text or context snippets. The req file is
 * transient and is removed on every exit path, including timeouts. The
 * attachment lives in memory only.
 *
 * Every branch is fail-open: a dead coach, a missing context, a malformed file,
 * or a timeout sends the user's words untouched.
 */

const IS_WINDOWS = process.platform === "win32"
const DATA =
  process.env.COACH_DATA_DIR ??
  join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "CodeCoachData")
const IPC = join(DATA, "ipc")
const LOG = join(DATA, "logs", "plugin.log")
const PID = join(DATA, "daemon.pid")

// Keep in lockstep with src/Coach.Daemon.ps1: its card deadline (4500 ms) must
// stay below DECISION_MS, and it answers well inside VERDICT_MS. The env
// override exists so tests can exercise timeouts without waiting ten seconds.
const VERDICT_MS = Number(process.env.COACH_VERDICT_MS) || 1500
const DECISION_MS = Number(process.env.COACH_DECISION_MS) || 5000
const POLL_MS = 40
const MAX_CTX_CHARS = 2200
const ATTACH_TTL_MS = 15 * 60 * 1000

interface PromptFile {
  uri?: string
  name?: string
  path?: string
  filename?: string
}

interface ContextMessage {
  id?: string
  role?: string
  type?: string
  text?: string
  files?: ReadonlyArray<PromptFile>
  parts?: ReadonlyArray<{ type?: string; text?: string | null }>
  content?: ReadonlyArray<{ type?: string; text?: string | null }>
  info?: { role?: string; id?: string }
}

interface ContextDigest {
  turn: number
  attempts: number
  files: string[]
  errors: string[]
  tests: string[]
  constraints: string[]
  success: string[]
  goals: string[]
}

interface Attachment {
  messageID: string | null
  original: string
  attachment: string
  at: number
  injected: boolean
}

// Attachments are per session and in memory only. A new user prompt replaces or
// clears the entry, so context can never leak into a later turn.
const pending = new Map<string, Attachment>()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function log(line: string) {
  try {
    mkdirSync(join(DATA, "logs"), { recursive: true })
    // The pid is what lets the doctor tell a gated session from a side-spawn
    // (the analyzer's own `opencode run` children load this plugin with
    // COACH_BYPASS set and never gate anything).
    appendFileSync(LOG, `${new Date().toISOString()}  [${process.pid}] ${line}\n`, "utf8")
  } catch {}
}

function coachAlive() {
  try {
    const pid = Number(readFileSync(PID, "utf8").trim())
    if (!Number.isInteger(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function bypassed() {
  const v = process.env.COACH_BYPASS
  if (!v) return false
  const s = String(v).trim().toLowerCase()
  return s !== "0" && s !== "false" && s !== "no"
}

// The plugin's only use for these is deciding whether a send is substantive
// enough to ask about; a non-substantive continuation skips the gate. They are
// a superset of the daemon's rules in src/Coach.Daemon.ps1, so a destructive
// ask the daemon would hold is never filtered out here first.
const HARD_DESTRUCTIVE = /\b(rm\s+-rf|git\s+clean|force[- ]?push|uninstall\w*|nuke\w*)\b/i
const DESTRUCTIVE_VERB =
  /\b(delete|deletes|deleting|reset|resets|resetting|revert|reverts|reverting|drop|drops|dropping|truncate|truncates|truncating|overwrite|overwrites|overwriting|wipe|wipes|wiping|purge|purges|purging|destroy|destroys|destroying|remove|removes|removing|clean\s?up|cleanup|clear|clears|clearing)\b/i
const DESTRUCTIVE_OBJECT =
  /\b(files?|folders?|directories?|dirs?|data|database|db|tables?|rows?|records?|logs?|history|branch(es)?|commits?|repo(sitory)?|worktree|build|output|cache|config|credentials?|secrets?|disk|drive|migrations?)\b/i
const DESTRUCTIVE_BROAD = /\b(all|everything)\b/i
const DESTRUCTIVE_GUARD =
  /\b(backup|backed up|committed|commit first|commit before|commit the current|dry[- ]?run|dry run|confirm|confirmed|only|specific|exact|this file|one file|snapshot)\b/i
const PLACE_NAMED =
  /(\.[a-z0-9]{1,5}\b|\b[A-Z][a-z]+-[A-Z][A-Za-z0-9]*\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b(module|service|component|screen|page|route|endpoint|function|class|file|controller|handler|view|readme|changelog)\b)/i
const NEW_TASK = /\b(new task|fresh task|different task|separate task|another task|next task|new request|start over|unrelated (task|request|ask))\b/i

const CHANGE_RE =
  /\b(fix|fixes|fixing|make|makes|making|improve|improves|improving|refactor\w*|rewrite|update|updates|updating|change|changes|changing|clean\s?up|handle|handles|handling|support|add|adds|adding|move|moves|rename|remove|removes|removing)\b/i
const FAILURE_RE =
  /\b(bug|bugs|broken|breaks|broke|fails?|failing|failed|failure|crash|crashes|wrong|doesn|don|didn|isn|won|cannot|can't|error|errors|hidden|stuck|flaky|intermittent|regression)\b/i
const FILE_RE =
  /\b[\w./\\-]+\.(?:ps1|psm1|psd1|js|mjs|cjs|ts|tsx|jsx|py|cs|go|rs|rb|java|kt|swift|json|ya?ml|toml|md|css|html|sql|sh|bash|bat|cmd|c|h|cpp|hpp)\b/gi
const ERROR_RE = /(?:error|exception|traceback|failed|failure|fatal|panic|TS\d{4}|at\s+\w+\(|line\s+\d+)/i
const TEST_RE =
  /(?:npm|pnpm|yarn|pytest|python\s+-m\s+pytest|go\s+test|cargo\s+test|dotnet\s+test|node\s+--test|uv\s+run|make\s+test|Run-[A-Za-z0-9_-]+\.ps1)/i
const CONSTRAINT_RE = /\b(without|don't|do not|keep|must|compat|only|just|no breaking|backward|smallest|minimal|limit|preserve|avoid)\b/i
const SUCCESS_RE =
  /\b(should|expect|expected|instead|supposed to|want it to|needs? to|so that|acceptance|prove|verify|when .* (?:should|must))\b/i

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "was", "were",
  "are", "you", "your", "can", "will", "would", "should", "please", "just", "into",
  "when", "what", "how", "not", "but", "its", "also", "then", "than", "them", "they",
  "there", "here", "make", "made", "fix", "fixes", "still", "doesnt", "doesn", "don",
  "want", "need", "needs", "like", "about", "over", "under", "after", "before",
  "more", "less", "very", "really", "much", "some", "any", "all",
])

function isDestructive(text: string) {
  if (DESTRUCTIVE_GUARD.test(text)) return false
  if (HARD_DESTRUCTIVE.test(text)) return true
  if (!DESTRUCTIVE_VERB.test(text)) return false
  if (DESTRUCTIVE_OBJECT.test(text)) return true
  return DESTRUCTIVE_BROAD.test(text) && !PLACE_NAMED.test(text)
}

function isNewTask(text: string) {
  return NEW_TASK.test(text)
}

function unique(items: Array<string | null | undefined>, max = 8) {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const t = String(item ?? "").trim()
    if (!t) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
    if (out.length >= max) break
  }
  return out
}

function sentences(text: unknown) {
  if (typeof text !== "string" || !text.trim()) return []
  return text
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 220)
}

function pickSentences(text: unknown, re: RegExp, max = 3) {
  const out: string[] = []
  for (const s of sentences(text)) {
    if (!re.test(s)) continue
    const t = s.length > 160 ? `${s.slice(0, 157)}...` : s
    if (!out.includes(t)) out.push(t)
    if (out.length >= max) break
  }
  return out
}

function extractFiles(text: unknown) {
  if (typeof text !== "string") return []
  const out: string[] = []
  for (const m of text.matchAll(FILE_RE)) {
    const t = m[0].replace(/[.,;:)\]}'"]+$/g, "")
    if (t.length >= 3) out.push(t)
  }
  return unique(out, 8)
}

function messageFiles(message: ContextMessage) {
  const files = Array.isArray(message?.files) ? message.files : []
  return files
    .map((f) => (typeof f === "string" ? f : f?.path ?? f?.filename ?? f?.name ?? f?.uri))
    .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
}

function extractErrors(text: unknown) {
  if (typeof text !== "string") return []
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (t.length < 8 || !ERROR_RE.test(t)) continue
    out.push(t.length > 160 ? `${t.slice(0, 157)}...` : t)
    if (out.length >= 3) break
  }
  return unique(out, 3)
}

function extractTests(text: unknown) {
  if (typeof text !== "string") return []
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().replace(/^[-*$>]\s*/, "")
    if (t.length < 4 || !TEST_RE.test(t)) continue
    out.push(t.length > 160 ? `${t.slice(0, 157)}...` : t)
    if (out.length >= 3) break
  }
  return unique(out, 3)
}

function tokenize(text: unknown) {
  const words = String(text ?? "").toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []
  return new Set(words.filter((w) => !STOPWORDS.has(w)))
}

function similarity(a: unknown, b: unknown) {
  const sa = tokenize(a)
  const sb = tokenize(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let hit = 0
  for (const w of sa) if (sb.has(w)) hit++
  return hit / (sa.size + sb.size - hit)
}

function trimContext(ctx: ContextDigest) {
  const dropOrder: Array<keyof ContextDigest> = ["goals", "constraints", "success", "tests", "files", "errors"]
  while (JSON.stringify(ctx).length > MAX_CTX_CHARS) {
    let dropped = false
    for (const key of dropOrder) {
      const value = ctx[key]
      if (Array.isArray(value) && value.length > 1) {
        ctx[key] = value.slice(0, Math.max(1, value.length - 1)) as never
        dropped = true
        break
      }
    }
    if (!dropped) break
  }
  return ctx
}

// Facts from the session, not the transcript. The current message is excluded
// by id because the prompt hook may run before or after it is admitted.
function buildContext(messages: ContextMessage[], currentText: string, currentId: string | null, promptFiles: string[]) {
  const prior = messages.filter((m) => (m?.type ?? m?.role) === "user" && m?.id !== currentId)
  const texts = prior.map((m) => (typeof m?.text === "string" ? m.text : "")).filter(Boolean)
  const attempts = texts.filter((t) => similarity(t, currentText) >= 0.45).length
  const files = unique([...texts.flatMap(extractFiles), ...prior.flatMap(messageFiles), ...promptFiles], 5)
  const errors = unique(texts.flatMap(extractErrors), 3)
  const tests = unique(texts.flatMap(extractTests), 3)
  const constraints = unique(texts.flatMap((t) => pickSentences(t, CONSTRAINT_RE, 2)), 2)
  const success = unique(texts.flatMap((t) => pickSentences(t, SUCCESS_RE, 2)), 2)
  const goals = unique(texts.flatMap((t) => pickSentences(t, CHANGE_RE, 2)), 2)
  return trimContext({
    turn: prior.length,
    attempts,
    files,
    errors,
    tests,
    constraints,
    success,
    goals,
  })
}

async function getContext(
  ctx: { session: { context: (input: { sessionID: string }) => Promise<unknown> } },
  sessionID: string | null,
  messageID: string | null,
  currentText: string,
  promptFiles: string[],
) {
  if (!sessionID || !messageID) return null
  try {
    if (!ctx?.session?.context) return null
    const messages = await ctx.session.context({ sessionID })
    if (!Array.isArray(messages)) return null
    return buildContext(messages as ContextMessage[], currentText, messageID, promptFiles)
  } catch {
    return null
  }
}

function drop(name: string, payload: unknown) {
  const file = join(IPC, name)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(payload), "utf8")
  renameSync(tmp, file)
}

function remove(name: string) {
  try {
    unlinkSync(join(IPC, name))
  } catch {}
}

async function poll(name: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const file = join(IPC, name)
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (existsSync(file)) {
      let raw = ""
      try {
        raw = readFileSync(file, "utf8")
      } catch {
        raw = ""
      }
      remove(name)
      if (raw) {
        try {
          const parsed = JSON.parse(raw)
          return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
        } catch {
          return null
        }
      }
    }
    await sleep(POLL_MS)
  }
  return null
}

function messageRole(message: ContextMessage) {
  return message?.role ?? message?.type ?? message?.info?.role ?? null
}

function messageId(message: ContextMessage) {
  return message?.id ?? message?.info?.id ?? null
}

function messageText(message: ContextMessage) {
  if (typeof message?.text === "string") return message.text
  const parts = Array.isArray(message?.parts)
    ? message.parts
    : Array.isArray(message?.content)
      ? message.content
      : []
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n")
}

function normalize(text: unknown) {
  return String(text ?? "").replace(/\s+/g, " ").trim()
}

function attachedContext(attachment: string) {
  return [
    "Code Coach context attached to the user's current message.",
    "The user's message is the request. Use this block only as grounding they already established; do not quote it back or mention the coach.",
    "",
    attachment,
  ].join("\n")
}

// `attachment` is the preferred field. An older daemon sends only `text` with
// the compiled prompt, so derive the context body by removing the draft the
// plugin already has. Never return the whole compiled prompt: the developer's
// words are the message, not context.
function verdictAttachment(verdict: Record<string, unknown> | null, original: string) {
  if (typeof verdict?.attachment === "string" && verdict.attachment.trim()) {
    return verdict.attachment.trim()
  }
  if (typeof verdict?.text === "string") {
    const full = verdict.text.trim()
    const base = String(original ?? "").trim()
    if (base && full.startsWith(base)) {
      const rest = full.slice(base.length).trim()
      if (rest) return rest
    }
  }
  return ""
}

export default Plugin.define({
  id: "code-coach",
  async setup(ctx) {
    log("plugin setup")
    if (!IS_WINDOWS && !process.env.COACH_DATA_DIR) {
      log("skip: unsupported platform")
      return
    }
    try {
      mkdirSync(IPC, { recursive: true })
    } catch {}
    const workspace = process.env.COACH_CWD || String(ctx?.location?.directory ?? "")

    await ctx.session.hook("prompt", async (event) => {
      let id = ""
      const sid = event?.sessionID ?? null
      // A new user prompt owns this turn. Any earlier attachment is stale.
      if (sid) pending.delete(sid)
      try {
        if (bypassed()) {
          log("skip: bypass")
          return
        }
        const prompt = event?.prompt
        const text = typeof prompt?.text === "string" ? prompt.text : ""
        if (!text || text.trim().length < 12) return
        if (text.trimStart().startsWith("/")) return
        // system-shaped payloads are not the user's ask: compaction summaries,
        // synthetic context blocks, subagent briefs. Never gate those.
        if (text.length > 4000) {
          log(`skip: too long len=${text.length}`)
          return
        }
        if (
          /^\s*</.test(text) ||
          /^\s*(you are\b|summari[sz]e\b|generate a (short )?title|write a (short )?title|create a (short )?title)/i.test(text)
        ) {
          log(`skip: system-shaped len=${text.length}`)
          return
        }
        if (!coachAlive()) return

        const promptFiles = Array.isArray(prompt?.files) ? messageFiles({ files: prompt.files }) : []
        const info = await getContext(ctx, event?.sessionID ?? null, event?.messageID ?? null, text, promptFiles)
        if (!info) {
          log("skip: context unknown")
          return
        }
        const risky = isDestructive(text) || isNewTask(text)
        const substantive = CHANGE_RE.test(text) || FAILURE_RE.test(text) || risky
        if (info.turn > 0 && !substantive) {
          log(`skip: continuation turn=${info.turn}`)
          return
        }
        if (promptFiles.length > 0 && !substantive) {
          log(`skip: attachment count=${promptFiles.length}`)
          return
        }

        id = randomUUID()
        drop(`req-${id}.json`, {
          id,
          text,
          ctx: info,
          cwd: workspace,
          sid: event?.sessionID ?? null,
        })
        log(
          `prompt len=${text.length} turn=${info.turn} files=${info.files.length} errors=${info.errors.length} tests=${info.tests.length} attempts=${info.attempts}`,
        )

        const verdict = await poll(`res-${id}.json`, VERDICT_MS)
        if (verdict && verdict.action === "attach") {
          const attachment = verdictAttachment(verdict, text)
          if (attachment && sid) {
            pending.set(sid, {
              messageID: event?.messageID ?? null,
              original: text,
              attachment,
              at: Date.now(),
              injected: false,
            })
            log(`attach len=${attachment.length} (prompt ${text.length} unchanged)`)
            return
          }
          log(`pass len=${text.length} (no attach context)`)
          return
        }
        if (!verdict || verdict.action !== "hold") {
          log(`pass len=${text.length}`)
          return
        }

        log(`hold - card up len=${text.length}`)
        const decision = await poll(`dec-${id}.json`, DECISION_MS)
        if (decision && decision.action === "attach") {
          const attachment = verdictAttachment(decision, text)
          if (attachment && sid) {
            pending.set(sid, {
              messageID: event?.messageID ?? null,
              original: text,
              attachment,
              at: Date.now(),
              injected: false,
            })
            log(`attach len=${attachment.length} (prompt ${text.length} unchanged)`)
            return
          }
        }
        log("sent as written")
      } catch (error) {
        log(`error ${error instanceof Error ? error.message : error}`)
      } finally {
        // Present until the decision is made; gone the moment we stop waiting.
        if (id) remove(`req-${id}.json`)
      }
    })

    // Model requests only. This is where earned context is attached: the
    // persisted user message and the composer are never touched.
    try {
      await ctx.session.hook("context", (event) => {
        try {
          const sessionID = event?.sessionID
          const entry = sessionID ? pending.get(sessionID) : null
          if (!entry) return
          if (Date.now() - entry.at > ATTACH_TTL_MS) {
            pending.delete(sessionID)
            return
          }
          const messages = Array.isArray(event?.messages) ? event.messages : []
          const lastUser = [...messages].reverse().find((m) => messageRole(m) === "user")
          if (lastUser) {
            const sameId = entry.messageID && messageId(lastUser) === entry.messageID
            const sameText = normalize(messageText(lastUser)) === normalize(entry.original)
            if (!sameId && !sameText) {
              // The turn has moved on. Never leak old context into a new one.
              pending.delete(sessionID)
              return
            }
          }
          if (!Array.isArray(event?.system)) return
          event.system.push({ type: "text", text: attachedContext(entry.attachment) })
          if (!entry.injected) {
            entry.injected = true
            log(`attach context len=${entry.attachment.length}`)
          }
        } catch (error) {
          log(`context error ${error instanceof Error ? error.message : error}`)
        }
      })
    } catch (error) {
      // A build without the context hook still sends every prompt unchanged.
      log(`context hook unavailable ${error instanceof Error ? error.message : error}`)
    }
  },
})
