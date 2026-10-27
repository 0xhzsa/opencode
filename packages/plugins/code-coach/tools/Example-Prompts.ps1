# Example-Prompts.ps1 - run the real pre-send decision engine on example drafts.
# Shows which asks the coach holds before sending (autosend attaches context
# silently), which sail through, and which principles it records either way.
# Post-send nudge cards are separate: they come from the triage lane, ~1-2 min
# after a send that names a real file.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'src\Coach.Common.ps1')
. (Join-Path $root 'src\Coach.Learner.ps1')
. (Join-Path $root 'src\Coach.Core.ps1')
. (Join-Path $root 'src\Coach.Principles.ps1')
. (Join-Path $root 'src\Coach.Intent.ps1')

$mods = $null
try { $mods = Get-LearnerModifiers (Get-LearnerState) } catch { $mods = $null }

function Verdict([string]$Name, [string]$Draft, $Ctx) {
  $d = Get-SmartDecision -Draft $Draft -Ctx $Ctx -Learner $mods
  $gap = if ($d.hold) { $d.gapId } else { 'no-gap (passes clean)' }
  $applied = if (@($d.applied).Count) { @($d.applied) -join ',' } else { '-' }
  $faithful = ''
  if ($d.hold) { $faithful = '  faithful=' + [bool]$d.faithful.ok }
  Write-Output ("{0,-31} hold={1,-5} gap={2}{3}" -f $Name, [bool]$d.hold, $gap, $faithful)
  Write-Output ("{0}principles seen: {1}" -f (' ' * 34), $applied)
}

$ctxCard = @{ Files = @('src/Coach.Card.ps1') }
$ctxAuth = @{ Files = @('auth.py') }

Verdict 'destructive  (broad wipe)' "delete all the old logs from the data folder, and reset the database if anything complains" ($null)
Verdict 'vague bug+file named'      "fix the bug in src/Coach.Card.ps1 and make it not suck" $ctxCard
Verdict 'broad ask'                 "improve my code" $null
Verdict 'vague+tonight'             "add a login endpoint in auth.py, take POST user/password and check it, make it work tonight" $ctxAuth
Verdict 'well-formed (should pass)' "refactor Get-HoldDecision in src/Coach.Intent.ps1, split the destructive branch into its own helper, keep Run-Focus green after, do not rename public functions" @{ Files = @('src/Coach.Intent.ps1') }
