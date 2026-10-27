# Code Coach (slice 1: the gate)

An opt-in opencode plugin that reviews a prompt **after** it is sent and stays
quiet unless it has a concrete objection. This first slice is the wire and the
card: a deterministic gate that answers `pass`, `attach`, or `hold`, plus one
Windows card that can add a guardrail to the outgoing model call.

The send is never held, rewritten, or re-sent. `prompt.text` is never mutated.

## What this slice does

| Prompt | Verdict | What the developer sees |
| --- | --- | --- |
| `Summarize the current state of the parser` | `pass` | nothing |
| `fix the login flow so the second attempt works` | `attach` | nothing; one `Target:` line rides along as context |
| `delete all the logs from last week` | `hold` | one card: **Add the guardrail** or **Send as written** |

- `pass` — no objection.
- `attach` — the ask names a change but no file, route, or function. The plugin
  adds one `Target:` sentence to the model request as a system block. The
  submitted text is untouched.
- `hold` — the ask destroys or rewrites state with no recovery point. One card
  offers the guardrail. If nobody clicks within 4.5 s, the prompt goes as
  written. **Add the guardrail** attaches the guardrail to that model call only;
  **Send as written** answers `pass`.

Two deterministic rules, no model call and no network:

1. destructive verb + destructive object, with no guard → `hold`
2. change verb, with no file named → `attach`
3. anything else → `pass`

## What is not here yet

This is the first reviewable slice requested in
[#59587](https://github.com/anomalyco/opencode/pull/59587). Later slices add:

- the triage lane (one model call per eligible send) and the security-intent
  heuristics
- Explain why, Fix my prompt, Ignore, Snooze
- the learner, lessons, insights, and persisted snooze state
- autostart install/uninstall, `coach-guard`, and the doctor
- the full live proof driver and screenshots

Until then the daemon is started by hand and stopped with a `stop` file.

## Requirements

- Windows 10 or 11. The daemon is Windows PowerShell 5.1 + WPF; on macOS and
  Linux the plugin logs `skip: unsupported platform` and leaves every prompt
  untouched.
- opencode with the v2 plugin API (`session.hook("prompt")` and
  `session.hook("context")`).
- Node or Bun only for the plugin's tests.

## Run it from a checkout

This is the supported setup for slice 1, because the daemon is a separate
process and is not started by the plugin.

1. Clone and install:

   ```powershell
   git clone https://github.com/anomalyco/opencode.git
   cd opencode
   bun install
   ```

2. Add the plugin to your opencode config. In `%USERPROFILE%\.config\opencode\opencode.json`
   (or the project's `opencode.jsonc`):

   ```jsonc
   {
     "plugins": ["./packages/plugins/code-coach"]
   }
   ```

3. Start the daemon in its own PowerShell window:

   ```powershell
   powershell -NoProfile -STA -ExecutionPolicy Bypass -File packages\plugins\code-coach\src\Coach.Daemon.ps1
   ```

   `COACH_DATA_DIR` overrides the data folder (`%LOCALAPPDATA%\CodeCoachData`).
   The daemon writes `daemon.pid`, `logs\daemon.log`, and `trace.jsonl` there.

4. Send a prompt from opencode. The plugin writes a request only when the send
   is substantive; the daemon answers it.

5. Stop the daemon:

   ```powershell
   New-Item -ItemType File (Join-Path $env:LOCALAPPDATA 'CodeCoachData\stop')
   ```

The daemon removes its pid file and the `stop` file on exit.

## Install the plugin from Git

The plugin half can be installed without a checkout:

```powershell
opencode plugin add 'git+https://github.com/anomalyco/opencode.git#path:packages/plugins/code-coach'
```

The daemon still has to run from a checkout in this slice. Autostart and a
one-command installer are a later slice.

## Privacy

- The request file holds the prompt text only while the plugin is waiting for a
  verdict (1.5 s, or 5 s for a card). The plugin deletes it on every exit path,
  including timeouts and errors.
- The daemon logs the prompt **length** and the verdict, never the text.
- There is no transcript, no key, and no network call in this slice.
- The guardrail attachment is held in memory by the plugin for 15 minutes and
  injected into one model call, then dropped.
- The plugin never reads assistant prose. Its digest is counts, file names, and
  short error/test/constraint snippets, capped at 2200 characters.

## Verify

```powershell
cd packages/plugins/code-coach
bun test                                  # 4 tests, fake daemon, all platforms
bun run typecheck:tsc                     # clean
powershell -File tests\Run-Minimal.ps1    # 38 live checks, Windows desktop
```

The live test starts the real daemon in a child process, writes the same
`req-<id>.json` the plugin writes, drives the card through UI Automation, and
parses every verdict with Node. Its receipt is in `docs/PROOF.md`.

## Files

| Path | What |
| --- | --- |
| `index.ts` | plugin half: digest, request, verdict, `context` hook |
| `src/Coach.Daemon.ps1` | daemon half: two rules, one card, pid guard |
| `index.test.ts` | fake-daemon tests for the plugin contract |
| `tests/Run-Minimal.ps1` | live end-to-end test for the daemon and card |
| `docs/IPC.md` | the file contract |
| `docs/PROOF.md` | receipts |

## Design notes

- **Post-send, not pre-send.** A pre-send gate turns a coach into a blocker and
  trains people to click through. A post-send card costs nothing when it is
  wrong.
- **The card cannot take focus.** The window uses `WS_EX_NOACTIVATE` and
  `ShowActivated = false`, so a click leaves the caret where it was.
- **Fail-open everywhere.** A dead daemon, a malformed file, a missing request,
  or a timeout sends the developer's words untouched. The gate has no path that
  drops a send.
- **One card at a time.** A second `hold` while a card is up is answered `pass`
  rather than stacked. Queuing is a later slice.
