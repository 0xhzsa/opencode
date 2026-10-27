# Proof — slice 1

Environment: Windows 11 Home Single Language, Windows PowerShell 5.1.26100.9711,
Bun 1.4.4, Node v22.23.1. The daemon and the test run on the same machine.

## 1. Plugin contract (all platforms)

`bun test` in `packages/plugins/code-coach`. No fake daemon, no timers, no
sleeps — the plugin has nothing to race:

```text
7 pass
0 fail
19 expect() calls
Ran 7 tests across 1 file. [315.00ms]
```

The seven tests assert:

- one destructive ask writes exactly one request, with the right `id`, `text`,
  `cwd`, and `sid`, and returns the event **deep-equal** to what it received
- the hook returns in under 100 ms with no daemon in the process at all, and
  creates no `res-` or `dec-` file (the old design waited 1.5 s + 5 s)
- with no `daemon.pid`, no prompt text is written to disk
- with a dead pid, no prompt text is written to disk
- continuations, slash commands, pastes over 4000 chars, system-shaped
  payloads, and `COACH_BYPASS` never write
- an IPC folder that cannot be written fails open instead of throwing
- the prompt text never appears in `plugin.log`

## 2. Types, lint, and parse

```text
bun run typecheck:tsc                 exit 0, no diagnostics
bun run typecheck                     no type errors in 164 files
oxlint packages/plugins/code-coach    0 warnings, 0 errors (2 files)
PowerShell parse                      2 files, 0 errors
```

## 3. Live gate (Windows)

![The card: "Destructive ask without a recovery point", with Copy the guardrail and Dismiss](proof/gate-card.png)

`tests/Run-Minimal.ps1` starts the real daemon in a child process, writes the
same `req-<id>.json` the plugin writes, drives the real WPF card through UI
Automation, and reads the real clipboard. Full output:

```text
[PASS] daemon wrote its pid file
[PASS] daemon process is alive
[PASS] destructive ask shows a card
[PASS] the request is consumed
[PASS] exactly one card
[PASS] clipboard can be seeded
[PASS] Copy the guardrail clicked
[PASS] clipboard holds the guardrail
[PASS] clipboard replaced the sentinel
[PASS] card closed after the copy
[PASS] non-destructive request is consumed
[PASS] non-destructive ask shows no card
[PASS] guarded request is consumed
[PASS] guarded destructive ask shows no card
[PASS] second destructive ask shows a card
[PASS] clipboard can be re-seeded
[PASS] Dismiss clicked
[PASS] card closed after dismiss
[PASS] dismiss left the clipboard alone
[PASS] card is up before the second ask
[PASS] second request is consumed
[PASS] still exactly one card
[PASS] card closes after the drop
[PASS] stale request is consumed
[PASS] stale request shows no card
[PASS] guard: second daemon exits 2
[PASS] guard: second daemon names the running pid
[PASS] no request files left behind
[PASS] no prompt text in daemon.log or trace.jsonl
[PASS] trace records a shown card
[PASS] trace records a copied guardrail
[PASS] trace records the dropped second card
[PASS] trace records the stale request
[PASS] stop: daemon exits on the stop file
[PASS] stop: pid file removed

checks: 35  failed: 0
minimal gate: PASS
```

What it proves:

- a destructive ask with no recovery point puts exactly one card on screen
- **Copy the guardrail** replaces the clipboard with the guardrail and closes
  the card
- **Dismiss** closes the card and leaves the clipboard untouched
- a non-destructive ask, and a destructive ask that names a recovery point,
  show no card
- a second destructive ask while a card is up is dropped, not stacked
- a request older than 120 s is dropped without a card
- no prompt text appears in `daemon.log` or `trace.jsonl`
- a second daemon on the same folder exits 2 and names the running pid
- the stop file shuts the daemon down and removes the pid file

## 4. Two bugs this work caught

**The hook was a pre-send gate.** The first revision polled for a verdict
(1.5 s) and then for a card decision (5 s) inside `session.hook("prompt")`.
opencode core awaits that hook inside `SessionPrompt.prepare`, before the
message is admitted, so the "post-send" coach was actually delaying every send
that matched. The upstream review caught it; the fix is structural — the hook
now does one file write and returns, and there is no channel back to the plugin
at all. `bun test` asserts the hook returns in under 100 ms with no daemon
present.

**The plugin never created its log directory.** If the plugin loaded before the
daemon had ever run, `appendFileSync` failed silently and the plugin produced no
log at all. The log-directory test caught it; setup now creates `logs\` next to
`ipc\`.

## 5. Scope

This receipt covers the nudge only: one rule, one card, a clipboard action, and
a one-file contract. It does not claim the triage lane, Explain why, Fix my
prompt, Snooze, the learner, autostart, or the doctor. Those are later slices
and are listed in the README.
