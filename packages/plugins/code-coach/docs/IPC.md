# IPC - the opencode gate contract

Two processes, three file types, one folder. This is the contract the tests
enforce; if a number changes here, it changes on both sides in the same commit.

| Half | Location |
|---|---|
| Plugin (writes requests, reads verdicts/decisions) | `packages\plugins\code-coach\index.ts` |
| Daemon (reads requests, writes verdicts/decisions) | `src\Coach.Gate.ps1`, `src\Coach.Daemon.ps1` |
| Folder | `%LOCALAPPDATA%\CodeCoachData\ipc\` (or `%COACH_DATA_DIR%\ipc`) |

The folder is derived from `COACH_DATA_DIR` when set, otherwise `LOCALAPPDATA`, in both halves
directory in the daemon. There is no config knob for it.

---

## 1. Sequence

```
developer presses Enter in the opencode TUI
  -> the plugin's "prompt" hook runs BEFORE the model request
  -> plugin reads the local session context and builds a bounded digest
       slash command, under 12 chars, question, system-shaped,
       review-only attachment, or non-substantive follow-up -> send, no req
       COACH_BYPASS=1                                       -> send, no req
       otherwise                                            -> continue
  -> plugin writes req-<id>.json { id, text, ctx, cwd, sid }
  -> plugin polls res-<id>.json for VERDICT_MS = 1500 ms
       {action:"attach", text, attachment} -> plugin keeps attachment; prompt.text unchanged
       {action:"hold"}                     -> plugin keeps req and waits for a decision
       {action:"pass"}                     -> plugin deletes req, the send proceeds
       no verdict                          -> plugin deletes req, the send proceeds (fail open)
  -> on hold, plugin polls dec-<id>.json for DECISION_MS = 5000 ms
       {action:"attach", text, attachment} -> plugin keeps attachment; prompt.text unchanged
       {action:"pass"}                     -> the model receives the draft
       no decision                         -> the model receives the draft
  -> immediately before dispatch, the plugin's "context" hook pushes the
     attachment onto event.system for this model call only
```

`attach` in the verdict is autosend: the daemon compiled a faithful context block
and the plugin attaches it without a card and without waiting. This is the default.
`hold` only happens in review mode, where the card carries the decision.

The attachment is never written into `prompt.text`. The developer's submitted
message is the message: persisted history, the composer, and the request text stay
exactly as typed. The context block is added to the outgoing model request as a
system part, so it affects that call and nothing else.

The card carries the decision. The daemon auto-passes at `GateHoldBudgetMs = 4000`,
leaving 1 s of margin inside the plugin's 5 s decision window. Requests older
than `GateStaleMs = 1200` are passed without a card; that is deliberately below
the plugin's 1.5 s verdict wait, so the daemon never gates a request the plugin
has already abandoned. The plugin's filters run before the request exists: if it
cannot read the session context, it sends without a card rather than guess that a
continuation is safe to compile.

The plugin deletes `req` on **every** exit path. Its absence is the cancel
signal: the daemon checks it immediately before showing a card and writes
`gate_withdrawn` + a pass instead of showing a card for a send that is already
gone. The daemon also deletes `req` after the card appears, so the prompt text
lives on disk for at most the hold budget, not for the cleanup window.

---

## 2. Files

Every write is atomic: write `<name>.tmp`, then move it over the target.
Encoding is UTF-8 **without** BOM.

### `req-<id>.json` - written by the plugin

```json
{
  "id": "<uuid>",
  "text": "<the prompt text the developer typed>",
  "cwd": "C:\\work\\app",
  "sid": "<session id>",
  "ctx": {
    "turn": 2,
    "attempts": 1,
    "files": ["src/Coach.Daemon.ps1"],
    "errors": ["card_shown after send"],
    "tests": ["tests/Run-Daemon.ps1"],
    "constraints": ["do not change the IPC file names"],
    "success": [],
    "goals": []
  }
}
```

`ctx` is a digest, not a transcript. Snippets are capped at 160 characters and the
whole digest at 2200; files, errors, tests, constraints, success and goals are
capped at five each. `cwd` is used only to read registered repo state (branch,
changed files, dirty) and never to walk an unregistered tree. `sid` is used only
for short-lived session memory (repeated asks, applied/retained principles). The
daemon never receives assistant prose, message bodies, or the full conversation.

### `res-<id>.json` - written by the daemon, read by the plugin

```json
{
  "id": "<same id>",
  "action": "attach",
  "text": "<the full compiled prompt>",
  "attachment": "<the context block, without the developer's words>"
}
```

```json
{ "id": "<same id>", "action": "hold" }
```

`action` is `pass`, `hold`, or `attach`. `text` and `attachment` are present only
for `attach`. `attachment` is the part that is delivered; `text` is kept for
compatibility and logging. `attach` is only written when the compiled prompt
passed `Test-SmartPromptFaithful` and the attachment is non-empty. A compiled
prompt that fails is not sent; the daemon answers `pass` so the draft goes and
the trace records `gate_unfaithful`.

An older daemon may send `{action:"rewrite", text}`. The plugin ignores it: only
`attach` is delivered, and the submitted prompt is never replaced.

### `dec-<id>.json` - written by the daemon, read by the plugin

```json
{
  "id": "<same id>",
  "action": "attach",
  "text": "<the full compiled prompt>",
  "attachment": "<the context block, without the developer's words>"
}
```

```json
{ "id": "<same id>", "action": "pass" }
```

`action` is `attach` or `pass`. `text` and `attachment` are present only for
`attach`.

Both `res` and `dec` are deleted by the plugin when it reads them. If the plugin
dies first, `Clear-GateFiles` removes anything older than 2 minutes.

---

## 3. Rules the daemon enforces

- **Delivery mode.** `promptMode` in `config.json` is `autosend` (default), `review`, or
  `off`; an unknown value is treated as `autosend`. The daemon reads it on every request.
  `off` and the pause / `KILL` switch answer `pass` without compiling.
- **Never clobber.** The plugin never assigns to `prompt.text`. The daemon's
  `attach` payload carries the context block separately; the submitted text stays
  the message. A watcher card with no gate copies to the clipboard instead of
  typing into the composer.
- **One gate at a time.** A second request while a review card is open is answered `pass`.
  Autosend has no gate to hold: a request is compiled and answered even while a watcher or
  code card is on screen.
- **Dedupe and throttle.** The 10-minute draft dedupe and the 20-second card throttle apply
  in review mode only. Autosend must never lose a send to either of them.
- **Turn filter (plugin-side).** Every substantive prompt is eligible, including a
  continuation. A slash command, under 12 characters, a question, a system-shaped
  payload, a review-only attachment, or a non-substantive follow-up passes untouched.
  If the session context is unavailable, the plugin sends without a card.
- **Bypass.** `COACH_BYPASS=1` makes the plugin send every prompt untouched. It exists
  for the A/B baseline and for debugging, not as a user setting.
- **Age.** A request older than 1200 ms is answered `pass`.
- **Withdrawal.** If `req` disappears before the card is shown, no card is shown;
  the gate finishes with `pass` and the trace records `gate_withdrawn`.
- **Size and shape.** Text under 12 chars, over 4000 chars, or starting with `/`
  is answered `pass`.
- **Pause / kill switch.** Every request is answered `pass` while paused or while
  the `KILL` file exists.
- **Cleanup.** `Clear-GateFiles` removes `req`/`res`/`dec` older than 2 minutes.
  Normal-path deletion is immediate: the plugin owns `req` on exit, the daemon
  owns it after the card, and the plugin owns `res`/`dec`.

---

## 4. What "attach" means

The daemon compiles a context block; it does not replace the developer's words. The
compiled prompt is:

```
<original draft, trimmed>

Context:                      (only when at least one fact exists)
- Target: ...
- Evidence: ...
- Tests: ...
- Limits: ...
[optional] - Prior attempts: ...
[optional] - Repo: ...

Finish line: <the clause>     (when one is stated)
```

The context lines come only from the draft, the plugin digest, and repo state under a
registered root. An unearned slot emits nothing: the compiled prompt carries no question
and no how-to section, because the coach's voice lives only on the nudge card. The compiler
never prints a placeholder, never pads with policy prose, and never invents a file, name,
number, error, or quoted specific. A test file named by the session is a fact line
(`- Tests:`), never a second target. The original draft is first, byte-for-byte. The builder
truncates at 1800; acceptance is bounded by `min(2200, max(900, draftLength*4 + 1200))`.
`Test-SmartPromptFaithful` rejects a lost original, an ungrounded file or number, label
syntax, and a runaway prompt.

When the compiled prompt cannot pass that check, autosend sends the draft
unchanged. Review mode can still fall back to the older one-sentence form on the
card:

```
<original draft> + "\n\nGuardrail: " + <one gap addition>
```

**Autosend** writes `{action:"attach", text, attachment}` into the verdict. The
plugin stores `attachment` for the session and the `context` hook pushes it onto
`event.system` for the outgoing model call. The prompt text is unchanged. In
review mode **Attach to send** writes the decision attach; **Copy prompt** copies
the compiled prompt and releases the send; **Send original** and the close glyph
write `{action:"pass"}`. A timeout or expiry is a pass plus a learner dismissal.
Nothing is typed into the composer and no key is simulated. A watcher card has no
gate, so accepting it copies the compiled prompt to the clipboard.

The attachment is derived by removing the trimmed draft prefix from the compiled
prompt (`Get-SmartAttachment`). If it is empty or the compiled prompt does not
start with the draft, the daemon passes instead of attaching.

---

## 5. Failure modes and required behaviour

| Failure | Required behaviour |
|---|---|
| `ipc` folder missing or unwritable | log it, answer nothing; the plugin fails open |
| Malformed request JSON | delete the file, answer `pass`, log length only |
| Coach not running | the plugin's 1500 ms verdict poll expires and the send proceeds |
| Coach dies during a hold | the plugin's 5 s decision poll expires and the send proceeds |
| Plugin withdraws during a hold | no card; daemon answers `pass` |
| Session context unavailable | the plugin cannot build the digest; no request, send proceeds |
| Two requests in the same tick | ids are unique; the second is answered `pass` |
| Draft contains instructions ("ignore your rules") | it is untrusted data; never executed, never logged, never given to a model with tools |

A broken coach shows nothing and never blocks a send. This is the contract's floor.

---

## 6. What must stay in lockstep

- `GateStaleMs` (1200) **must** be below the plugin's `VERDICT_MS` (1500).
- `GateHoldBudgetMs` (4000) **must** leave at least 1 s inside the plugin's
  `DECISION_MS` (5000).
- The plugin's timings are env-overridable (`COACH_VERDICT_MS`,
  `COACH_DECISION_MS`) only so tests can exercise timeouts; production uses the
  defaults above.
- The plugin's context digest is capped at `MAX_CTX_CHARS = 2200`, each snippet at
  160 characters, and each list at five entries. The daemon's compiled prompt is
  capped at 2200. Increasing either without measuring the model request is a
  contract change, not a tweak.
- `COACH_BYPASS=1` is the baseline switch for the A/B trial. It must stay a
  one-variable, process-local override.
- The plugin constants and the daemon constants must move together; `index.test.ts` covers the plugin side and fails if
  either inequality is broken. Do not bypass that check.
- `index.test.ts` asserts the request keys, the digest shape, the
  snippet bounds, the privacy boundary, the continuation gate, the bypass, and
  that `prompt.text` is byte-identical after every path while an `attach`
  verdict adds context through the `context` hook without waiting for `dec`.
- The destructive and new-task regexes exist on both sides. The plugin uses them to
  decide whether a continuation is worth interrupting; the daemon uses them to pick
  the checkpoint addition. Keep the two lists in lockstep.

