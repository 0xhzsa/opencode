# Code Coach

An opt-in opencode plugin that reviews a prompt **after** it is sent and stays
quiet unless it has a concrete objection. When it does, one small Windows card
offers **Explain why**, **Fix my prompt**, **Ignore**, and **Snooze**.

The send is never held back, rewritten, or re-sent. `prompt.text` is never
mutated. The card is advice for the next send, not a gate on this one.

## What it catches

- security-shaped asks that name no file: plaintext password comparison,
  missing rate limiting, user enumeration, SQL injection, secrets in code
- a prompt that names a file but not the finish line or the check that proves it
- a repeat of the same ask after an earlier attempt, with the earlier context
- a destructive ask ("delete all the logs, reset the database") with no
  recovery point

Silence is the default. The daemon makes one bounded triage call per eligible
send and records `triage_silent` when there is nothing worth a card.

## Requirements

- Windows 10/11, Windows PowerShell 5.1
- opencode v2 with plugin support
- a small OpenAI-compatible model endpoint, or the opencode CLI fallback

The daemon is PowerShell + WPF. The plugin is TypeScript and runs inside
opencode. On non-Windows platforms the plugin logs `skip: unsupported platform`
and leaves prompts untouched; the daemon does not run there.

## Install

1. Install the plugin from Git:

```powershell
opencode plugin add 'git+https://github.com/anomalyco/opencode.git#path:packages/plugins/code-coach'
```

2. Get the daemon and install the logon guard once:

```powershell
git clone --depth 1 https://github.com/anomalyco/opencode.git
cd opencode\packages\plugins\code-coach
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

`install-autostart.ps1` writes
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\CodeCoach` to the guard,
which starts the daemon and restarts it if it dies. Keep the checkout in place,
or rerun the script after moving it. To run the daemon in the foreground
instead:

```powershell
powershell -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File src\Coach.Daemon.ps1
```

3. Configure a triage model. The built-in free pool is the fallback; your own
provider is a small OpenAI-compatible endpoint. Put the key in an environment
variable and only its **name** in config:

```powershell
[Environment]::SetEnvironmentVariable('COACH_TRIAGE_KEY', 'sk-...', 'User')
```

```json
{
  "triageApiBase": "https://api.openai.com/v1",
  "triageApiKeyEnv": "COACH_TRIAGE_KEY",
  "triageModelName": "gpt-4o-mini"
}
```

Restart the daemon after changing the environment. The key is read at call time
and never written to config, logs, or the trace.

## Use

Send a prompt that has a real gap, for example:

> Add a login endpoint that checks the user's password against the database

A card appears after the send. **Explain why** teaches the missing idea:
password hashing with a per-user salt, constant-time comparison, rate limiting,
and generic errors. **Fix my prompt** copies a sharpened version to the
clipboard; your original send is untouched. **Snooze** silences nudges for 120
minutes.

A clean, specific send gets nothing. That is the product.

## Verify

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\Coach-Doctor.ps1
```

`doctor verdict: GO` means the daemon is alive, the logon guard is installed, the
plugin is registered, and the plugin log shows a recent gated prompt. The doctor
prints modes, names, counts, and timestamps; it never prints prompt text or keys.

The plugin half has a Bun test in this package:

```sh
bun test
```

The live Windows proof (24 pass / 0 warn / 0 fail on the real daemon and card)
and the 612-check suite receipt are in [docs/PROOF.md](docs/PROOF.md). The IPC
contract is in [docs/IPC.md](docs/IPC.md).

## Privacy

- No transcript is stored. The plugin sends a bounded digest: counts, file names,
  short error/test/constraint snippets, capped at 2200 characters.
- The daemon keeps the draft in memory for the triage call and does not write it
  to disk. `storeDraftText` defaults to `false`.
- The triage key is read from the environment variable named by
  `triageApiKeyEnv`; it is never logged.
- Cards are local WPF windows. Nothing is uploaded except the configured model
  call.

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall.ps1
opencode plugin remove 'git+https://github.com/anomalyco/opencode.git#path:packages/plugins/code-coach'
```

`uninstall.ps1` removes the autostart entry, stops only processes whose command
line points at this checkout, and (unless `-KeepData`) removes
`%LOCALAPPDATA%\CodeCoachData`. It does not touch opencode or its provider keys.
