# Coach.Daemon.ps1 - the resident coach: tray, gate, watcher, card, learner.
#
# One UI thread runs a WPF dispatcher (the card needs it) and hosts the WinForms
# tray icon (the dispatcher pumps its messages too). Nothing here blocks a send:
# the gate answers from the deterministic lane in milliseconds, the card has a
# deadline, and every failure path answers "pass".

param([switch]$Force, [switch]$DryRun)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Coach.Common.ps1')
. (Join-Path $PSScriptRoot 'Coach.Trace.ps1')
. (Join-Path $PSScriptRoot 'Coach.Core.ps1')
. (Join-Path $PSScriptRoot 'Coach.Principles.ps1')
. (Join-Path $PSScriptRoot 'Coach.Intent.ps1')
. (Join-Path $PSScriptRoot 'Coach.Card.ps1')
. (Join-Path $PSScriptRoot 'Coach.CardWindow.ps1')
. (Join-Path $PSScriptRoot 'Coach.Gate.ps1')
. (Join-Path $PSScriptRoot 'Coach.Surfaces.ps1')
. (Join-Path $PSScriptRoot 'Coach.Lessons.ps1')
. (Join-Path $PSScriptRoot 'Coach.Learner.ps1')
. (Join-Path $PSScriptRoot 'Coach.Insights.ps1')
. (Join-Path $PSScriptRoot 'Coach.Code.ps1')
. (Join-Path $PSScriptRoot 'Coach.Analyzer.ps1')
. (Join-Path $PSScriptRoot 'Coach.Triage.ps1')

Initialize-CoachData
Write-CoachLog 'daemon: starting'

$old = @(Test-OldCoachRunning)
if ($old.Count -gt 0 -and -not $Force) {
  $principleIds = ($old | ForEach-Object { $_.pid }) -join ','
  Write-CoachLog ("daemon: refused - old install still running (pid $principleIds)")
  exit 3
}

$mutex = Enter-CoachInstance
if (-not $mutex) {
  Write-CoachLog 'daemon: another instance is already running'
  exit 4
}

Initialize-Trace | Out-Null
Write-TraceEvent 'daemon_started' @{ pid = $PID; ver = 2 }

# The coach never reviews its own tree: its fixtures are full of fake secrets.
$script:CoachHome = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script:CodeWatermark = [DateTime]::UtcNow.AddMinutes(-15)
[DateTime]$script:LastCodeScan = [DateTime]::MinValue
# Analyzer findings are held here between the worker and the card, and cleared
# when the next pass starts. They are candidates, not cards: the code pass
# still applies the repeat window and the one-finding budget.
$script:AnalyzerFindings = @()
$script:AnalyzerRoots = @()
[DateTime]$script:LastAnalyzer = [DateTime]::MinValue
$script:LastTriage = [DateTime]::MinValue
$script:TriageReserve = $null
$script:TriageSnoozeUntil = $null
# Auto-heal record for a send whose triage was skipped for missing facts: one
# targeted analyzer pass for the named files, then one retry. The draft and
# context live in memory only, exactly like the gate's own state.
$script:TriageHeal = $null
# One send held for the next spacing window. A send that lands during an
# in-flight pass or inside the spacing window used to be dropped forever, which
# made a burst of prompts look like "the coach had nothing to say" about every
# prompt after the first. Latest send wins; the slot is cleared when it starts.
$script:TriagePending = $null
# What the in-flight triage job was asked about. Collect-Triage needs the draft
# and facts to check the answer for invented file references; the job object
# only carries the model conversation.
$script:TriageMeta = $null

# The two budgets and a Snooze click survive a restart; a quiet hour that resets
# every time the daemon crashes is not quiet. Written once per card or click, so
# this never becomes a hot path.
function Save-CoachStateFile {
  $state = @{
    version     = 1
    snoozeUntil = if ($script:TriageSnoozeUntil) { $script:TriageSnoozeUntil.ToString('o') } else { $null }
    cardTimes   = @($script:CardTimes | ForEach-Object { $_.ToString('o') })
    triageTimes = @($script:TriageTimes | ForEach-Object { $_.ToString('o') })
  }
  [void](Save-CoachState $state)
}

function Restore-CoachStateFile {
  $s = Read-CoachState
  if (-not $s) {
    # A cold start still writes the marker: "no file" is a fact the proof and
    # the doctor both need to see, not a reason to be silent.
    Write-TraceEvent 'state_restored' @{ cards = 0; triage = 0; snoozed = $false; fresh = $true }
    return
  }
  Restore-BudgetTimes (Get-CtxList $s 'cardTimes') (Get-CtxList $s 'triageTimes')
  $raw = [string](Get-CtxValue $s 'snoozeUntil')
  if ($raw) {
    try {
      $at = [datetime]::Parse($raw, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
      if ($at -gt [datetime]::UtcNow) { $script:TriageSnoozeUntil = $at }
    } catch { }
  }
  Write-TraceEvent 'state_restored' @{
    cards   = $script:CardTimes.Count
    triage  = $script:TriageTimes.Count
    snoozed = [bool]($script:TriageSnoozeUntil -and $script:TriageSnoozeUntil -gt [datetime]::UtcNow)
  }
}

Restore-CoachStateFile

if ($DryRun) {
  Write-Output ('dry-run: modules loaded, data=' + $script:CoachData + ', trace=' + $script:TracePath)
  exit 0
}

# One-time WPF and card-visual cost (measured: 1.08 s build + 0.19 s first show).
# Pay it before the pid exists, so the plugin cannot send into a half-warm daemon
# and the first real card does not lose a third of its 4 s decision budget.
$warmSw = [Diagnostics.Stopwatch]::StartNew()
$warmOk = $false
try {
  $warmModel = @{
    kind        = 'prompt'
    consequence = 'Preparing the card window before the first real draft.'
    gaps        = @(@{ label = 'Place'; text = 'the place is not named' })
    more        = 0
    compiled    = 'Name the place before sending.'
    finding     = $null
    lesson      = 'Name the place.'
    why         = 'Name the place.'
    maxHeight   = 0
  }
  # Warm the same placement maths the real card uses, then show and close one
  # card through the real window path (chrome, capture exclusion, focus guard).
  # The window is far off-screen and never activated.
  [void](Get-CardPlacement -Composer @{ left = 0; top = 0; right = 900; bottom = 700 } `
    -WorkArea @{ left = 0; top = 0; right = 1920; bottom = 1040 } -CardWidth 400 -CardHeight 360)
  $warmCard = Show-CoachCardWindow -Model $warmModel -Placement @{ left = -32000; top = -32000; side = 'warm' } -ExcludeFromCapture $true
  Close-CoachCardWindow $warmCard
  $warmCard = $null
  $warmOk = $true
} catch {
  Write-CoachLog ('card warm failed: ' + $_.Exception.Message)
}
$warmSw.Stop()
Write-TraceEvent 'card_warm' @{ ok = $warmOk; ms = [int]$warmSw.ElapsedMilliseconds }

# The plugin checks this file before it gates anything: a coach that is not
# running must cost the send nothing, not 1.5 seconds of polling. Write it only
# after the warm-up: pid means "ready to answer", not "process exists".
$script:PidPath = Join-Path $script:CoachData 'daemon.pid'
[IO.File]::WriteAllText($script:PidPath, [string]$PID, (New-Object Text.UTF8Encoding($false)))

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# A WPF Application spends seconds before it starts pumping; a dispatcher frame
# pumps from the first millisecond, and the card needs nothing more than that.
$script:Ui = [System.Windows.Threading.Dispatcher]::CurrentDispatcher
$script:UiFrame = New-Object System.Windows.Threading.DispatcherFrame

$script:IpcDir = Get-GateFolder
if (-not (Test-Path -LiteralPath $script:IpcDir)) { New-Item -ItemType Directory -Force -Path $script:IpcDir | Out-Null }
$script:Gate = New-GateState
$script:Learner = Get-LearnerState
$script:Active = $null
$script:Seen = @{}
$script:LastCardAt = [DateTime]::MinValue
$script:LastRejected = @{}
$script:SessionMemory = @{}
$script:FocusHandler = $null

$script:State = @{
  capture = (Get-CoachConfig).capture
  paused  = $false
  cfg     = Get-CoachConfig
}
$script:SeenCode = Read-CodeSeen $script:SeenCodePath ([double]$script:State.cfg.codeRepeatHours)

function Set-StateFromConfig {
  $script:State.cfg = Get-CoachConfig
  $script:State.paused = ((Get-CoachPauseSeconds $script:State.cfg) -gt 0)
  $script:State.capture = [bool]$script:State.cfg.capture
  $script:Learner = Get-LearnerState
}

function Test-Silent {
  if (Test-CoachKilled) { return $true }
  if ($script:State.paused) { return $true }
  return (Test-CoachSilent $script:State.cfg)
}

function Get-TextHash([string]$Text) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $h = $sha.ComputeHash($bytes)
    return (($h[0..7] | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally { $sha.Dispose() }
}

function Test-DraftLike([string]$Text) {
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  $t = $Text.Trim()
  if ($t.Length -lt 18 -or $t.Length -gt 4000) { return $false }
  $words = @($t -split '\s+' | Where-Object { $_ })
  return ($words.Count -ge 4)
}

function Get-ComposerRect {
  # Win32 only: a UIA read here can block the UI thread for seconds.
  try {
    $fg = [CoachWin32]::GetForegroundWindow()
    if ($fg -eq [IntPtr]::Zero) { return $null }
    $r = New-Object CoachWin32+RECT
    if (-not [CoachWin32]::GetWindowRect($fg, [ref]$r)) { return $null }
    if (($r.Right - $r.Left) -lt 40) { return $null }
    return @{ left = [double]$r.Left; top = [double]$r.Top; right = [double]$r.Right; bottom = [double]$r.Bottom }
  } catch { return $null }
}

$script:WorkingArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

function Get-Placement {
  param([double]$CardHeight = 360)
  $rect = Get-ComposerRect
  if ($rect) {
    $screen = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point([int]$rect.left, [int]$rect.top)))
    $wa = $screen.WorkingArea
    $work = @{ left = $wa.Left; top = $wa.Top; right = $wa.Right; bottom = $wa.Bottom }
    return (Get-CardPlacement -Composer $rect -WorkArea $work -CardWidth 400 -CardHeight $CardHeight)
  }
  return @{ left = ($script:WorkingArea.Right - 424); top = ($script:WorkingArea.Top + 48); side = 'corner' }
}

function New-CardModel($Decision, [string]$Kind) {
  # A nudge is not a gap card: it has no gap rows, no compiled context, no
  # principle. Its body is the model's nudge (60 words, plain words), and its
  # WHY section is the explanation + optional quiz, revealed only on a click.
  if ($Kind -eq 'nudge') {
    return @{
      kind             = 'nudge'
      consequence      = [string]$Decision.nudge
      gaps             = @()
      more             = 0
      addition         = ''
      compiled         = ''
      followUp         = [string]$Decision.followUp
      attachment       = ''
      betterPrompt     = [string]$Decision.betterPrompt
      approach         = @()
      grounding        = @()
      principles       = @()
      principle        = ''
      principleName    = $null
      smart            = $true
      ctxFilled        = $null
      finding          = $null
      lesson           = ''
      why              = [string]$Decision.why
      showWhy          = $false
      sendsAsWritten   = $false
      countdownSeconds = 0
      footerPrefix     = 'Triage'
      footerNote       = if ($Decision.model) { 'draft sent to ' + [string]$Decision.model } else { 'draft sent to your configured model' }
      groundingKind    = [string]$Decision.grounding
      maxHeight        = [double]([math]::Max(300, $script:WorkingArea.Height * 0.5))
    }
  }
  $rows = @()
  foreach ($g in @($Decision.gaps)) {
    if ($rows.Count -ge 3) { break }
    $rows += @{ label = (Get-GapLabel $g.id); text = [string]$g.evidence }
  }
  $lesson = Get-NextLesson $script:Learner ([string]$Decision.gapId)
  if (-not $lesson) { $lesson = $Decision.lesson }
  $principle = Get-Principle ([string]$Decision.principle)
  $principleName = $null
  if ($principle) { $principleName = [string]$principle.name }
  return @{
    kind             = $Kind
    consequence      = [string]$Decision.consequence
    gaps             = $rows
    more             = [math]::Max(0, @($Decision.gaps).Count - 3)
    addition         = [string]$Decision.addition
    compiled         = [string]$Decision.compiled
    followUp         = [string]$Decision.followUp
    attachment       = [string]$Decision.attachment
    approach         = if ($Decision.approach) { @($Decision.approach) } else { @() }
    grounding        = if ($Decision.grounding) { @($Decision.grounding) } else { @() }
    principles       = if ($Decision.principles) { @($Decision.principles) } else { @() }
    principle        = [string]$Decision.principle
    principleName    = $principleName
    smart            = [bool]$Decision.smart
    ctxFilled        = $Decision.ctxFilled
    finding          = $Decision.finding
    lesson           = [string]$lesson
    why              = [string]$Decision.lesson
    showWhy          = $false
    sendsAsWritten   = $false
    countdownSeconds = 0
    maxHeight        = if ($Kind -eq 'prompt') {
                         [double]([math]::Max(320, $script:WorkingArea.Height * 0.55))
                       } else {
                         [double]($script:WorkingArea.Height * 0.6)
                       }
  }
}

function Close-ActiveCard {
  param([string]$Reason = 'closed')
  if (-not $script:Active) { return }
  try { if ($script:Active.timer) { $script:Active.timer.Stop() } } catch { }
  try { Close-CoachCardWindow $script:Active.card } catch { }
  $script:Active = $null
  Write-TraceEvent 'card_closed' @{ reason = $Reason }
}

# A card that times out or expires was ignored. Count it like a dismissal so
# three silent cards in a row quiet that gap; otherwise the learner never sees
# the cards the user actually ignores.
function Learn-IgnoredCard([string]$Reason) {
  if (-not $script:Active) { return }
  if ($script:Active.kind -eq 'nudge') {
    # A nudge has no gap id: silence it in the tag counts, not in mastery.
    try { Update-TriageTags $script:Learner @($script:Active.tags) 'dismissed' } catch { }
    Write-TraceEvent 'nudge_ignored' @{ reason = $Reason; tags = (@($script:Active.tags) -join ',') }
    return
  }
  if ($script:Active.kind -eq 'review') {
    Write-TraceEvent 'review_ignored' @{ principle = [string]$script:Active.principle; reason = $Reason }
    return
  }
  $gap = [string]$script:Active.gapId
  if (-not $gap) { return }
  try {
    $script:Learner = Update-LearnerState $script:Learner $gap 'dismissed'
    Save-LearnerState $script:Learner
    Write-TraceEvent 'card_ignored' @{ gap = $gap; reason = $Reason }
  } catch {
    Write-CoachLog ('learner ignored: ' + $_.Exception.Message)
  }
}

function Complete-CardAction {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('accepted', 'copied', 'dismissed', 'review_pass', 'review_fail', 'explain', 'nudge_fixed', 'nudge_dismissed', 'nudge_snoozed')][string]$Action
  )
  if (-not $script:Active) { return }
  $a = $script:Active
  $gateId = $a.gateId
  # What the developer can carry away: a prompt card carries the context body
  # (their words are already theirs); a code card carries the follow-up.
  $payload = if ($a.kind -eq 'code') { [string]$a.followUp } else { [string]$a.attachment }

  if ($a.kind -eq 'review') {
    if ($Action -eq 'review_pass' -or $Action -eq 'review_fail') {
      foreach ($principleId in @($a.principles)) {
        try {
          $script:Learner = Update-PrincipleState $script:Learner ([string]$principleId) $Action
          Save-LearnerState $script:Learner
        } catch { }
      }
      Write-TraceEvent $Action @{ principle = @($a.principles) -join ',' }
    } elseif ($Action -eq 'dismissed') {
      Write-TraceEvent 'review_dismissed' @{ principle = @($a.principles) -join ',' }
    }
    Close-ActiveCard -Reason $Action
    return
  }

  # The nudge card: no gate behind it, ever. Explain why rebuilds in place;
  # fixed copies the better prompt to the clipboard (an explicit click is the
  # only permission this product ever needs); everything else is a dismissal.
  if ($a.kind -eq 'nudge') {
    if ($Action -eq 'explain') {
      $d = $a.nudgeDecision
      $secs = [int](Get-CtxValue $script:State.cfg 'triageExplainSeconds')
      if ($secs -lt 60) { $secs = 60 }
      Close-ActiveCard -Reason 'explain'
      if ($d) { [void](Show-Card $d 'nudge' '' $null -AutoHideSeconds $secs -ShowWhy) }
      return
    }
    if ($Action -eq 'nudge_fixed') {
      if ($a.betterPrompt) { try { [System.Windows.Clipboard]::SetText([string]$a.betterPrompt) } catch { } }
      try { Update-TriageTags $script:Learner @($a.tags) 'accepted' } catch { }
      Write-TraceEvent 'nudge_fixed' @{ tags = (@($a.tags) -join ',') }
      Close-ActiveCard -Reason 'nudge_fixed'
      return
    }
    if ($Action -eq 'nudge_snoozed') {
      # Bought quiet, not approval: the tag counters still record a
      # dismissal, and the triage lane stays silent for the config minutes.
      $script:TriageSnoozeUntil = [DateTime]::UtcNow.AddSeconds((Get-TriageSnoozeSeconds $script:State.cfg))
      # Persisted on the click, not on shutdown: a crash during the quiet hours
      # must not hand the developer their interruptions back.
      Save-CoachStateFile
      try { Update-TriageTags $script:Learner @($a.tags) 'dismissed' } catch { }
      Write-TraceEvent 'card_snoozed' @{ minutes = [int]((Get-TriageSnoozeSeconds $script:State.cfg) / 60) }
      Close-ActiveCard -Reason 'snoozed'
      return
    }
    try { Update-TriageTags $script:Learner @($a.tags) 'dismissed' } catch { }
    Write-TraceEvent 'nudge_ignored' @{ tags = (@($a.tags) -join ',') }
    Close-ActiveCard -Reason $Action
    return
  }

  # The card has to be off screen before the parked send is released. Releasing
  # first starts the model request while the developer still sees the card.
  Close-ActiveCard -Reason $Action

  if ($Action -eq 'accepted' -and $gateId) {
    # Attach the compiled context to the send that is already parked at the
    # gate. The developer's text still goes out exactly as they wrote it.
    [void](Invoke-GateFinish -State $script:Gate -IpcDir $script:IpcDir -Action attach -Text $a.compiled -Attachment $a.attachment)
  } elseif (($Action -eq 'dismissed' -or $Action -eq 'copied') -and $gateId) {
    # Copy closes the card; the held send must leave now as written, not wait
    # for the plugin's decision timeout.
    [void](Invoke-GateFinish -State $script:Gate -IpcDir $script:IpcDir -Action pass)
  }

  if ($Action -eq 'accepted' -and -not $gateId) {
    # A watcher card has no gate to answer. Never write into the composer: the
    # developer may have kept typing since the card was built. Put only the
    # context body on the clipboard, never their draft plus old boilerplate.
    try { [System.Windows.Clipboard]::SetText($payload) } catch { }
  }

  if ($Action -eq 'copied') {
    try { [System.Windows.Clipboard]::SetText($payload) } catch { }
  }

  try { $script:Learner = Update-LearnerState $script:Learner $a.gapId $Action; Save-LearnerState $script:Learner } catch { }
  foreach ($principleId in @($a.principles)) {
    try {
      $script:Learner = Update-PrincipleState $script:Learner ([string]$principleId) $Action
      Save-LearnerState $script:Learner
    } catch { }
  }
  if ($Action -eq 'accepted' -or $Action -eq 'copied') {
    if ($a.sidHash) {
      $script:SessionMemory[$a.sidHash] = @{ at = [DateTime]::UtcNow; principles = @($a.principles) }
    }
  }
  Write-TraceEvent $Action @{ gap = $a.gapId; dh = $a.draftHash; len = if ($payload) { $payload.Length } else { 0 }; principle = @($a.principles) -join ','; smart = [bool]$a.smart }
  if ($a.kind -eq 'code') {
    if ($Action -eq 'copied') { Write-TraceEvent 'code_suggestion_copied' @{ rule = [string]$a.rule; principle = [string]$a.principle } }
    elseif ($Action -eq 'dismissed') { Write-TraceEvent 'code_suggestion_dismissed' @{ rule = [string]$a.rule; principle = [string]$a.principle } }
  } elseif ($a.smart) {
    if ($Action -eq 'accepted') { Write-TraceEvent 'smart_prompt_accepted' @{ gap = $a.gapId; principle = @($a.principles) -join ',' } }
    elseif ($Action -eq 'copied') { Write-TraceEvent 'smart_prompt_copied' @{ gap = $a.gapId; principle = @($a.principles) -join ',' } }
    elseif ($Action -eq 'dismissed') { Write-TraceEvent 'smart_prompt_dismissed' @{ gap = $a.gapId; principle = @($a.principles) -join ',' } }
  } else {
    if ($Action -eq 'accepted') { Write-TraceEvent 'guardrail_accepted' @{ gap = $a.gapId } }
  }
}

function Connect-CardActions($Card, [bool]$CanApply) {
  $buttons = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($Card.window.Content)
  while ($queue.Count -gt 0) {
    $node = $queue.Dequeue()
    if ($node -is [System.Windows.Controls.Button]) { [void]$buttons.Add($node) }
    $n = [System.Windows.Media.VisualTreeHelper]::GetChildrenCount($node)
    for ($i = 0; $i -lt $n; $i++) { $queue.Enqueue([System.Windows.Media.VisualTreeHelper]::GetChild($node, $i)) }
  }
  foreach ($b in $buttons) {
    $name = [System.Windows.Automation.AutomationProperties]::GetName($b)
    if ($name -eq 'Attach to send' -or $name -eq 'Add the guardrail' -or $name -eq 'Use this prompt') {
      if (-not $CanApply) { $b.IsEnabled = $false; continue }
      # Script scope: a function-local captured here would read $null at click time.
      $b.add_Click({ Complete-CardAction -Action accepted })
    } elseif ($name -eq 'Copy prompt' -or $name -eq 'Copy the prompt' -or $name -eq 'Copy this prompt' -or $name -eq 'Copy follow-up prompt' -or $name -eq 'Copy follow-up') {
      $b.add_Click({ Complete-CardAction -Action copied })
    } elseif ($name -eq 'Explain why') {
      $b.add_Click({ Complete-CardAction -Action explain })
    } elseif ($name -eq 'Fix my prompt') {
      $b.add_Click({ Complete-CardAction -Action nudge_fixed })
    } elseif ($name -eq 'Ignore') {
      $b.add_Click({ Complete-CardAction -Action nudge_dismissed })
    } elseif ($name -eq 'Snooze') {
      $b.add_Click({ Complete-CardAction -Action nudge_snoozed })
    } elseif ($name -eq 'Got it') {
      $b.add_Click({ Complete-CardAction -Action review_pass })
    } elseif ($name -eq 'Not yet') {
      $b.add_Click({ Complete-CardAction -Action review_fail })
    } elseif ($name -eq 'Send original' -or $name -eq 'Send as is' -or $name -eq 'Dismiss card' -or $name -eq 'Dismiss') {
      $b.add_Click({ Complete-CardAction -Action dismissed })
    }
  }
}

function Show-Card($Decision, [string]$Kind, [string]$Draft, $SurfaceElement, [int]$AutoHideSeconds = 0, [bool]$AutoSend = $false, [switch]$ShowWhy) {
  $model = New-CardModel $Decision $Kind
  # Explain why rebuilds the same card on the spot; reveal only lives for that.
  if ($ShowWhy) { $model.showWhy = $true }
  if ($AutoSend) {
    $model.sendsAsWritten = $true
    $model.countdownSeconds = [int][math]::Ceiling($script:GateHoldBudgetMs / 1000.0)
  }

  $canApply = $true
  if ($Kind -eq 'prompt' -and $SurfaceElement) {
    $vp = $null
    $canApply = $false
    try {
      if ($SurfaceElement.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
        $canApply = (-not $vp.Current.IsReadOnly)
      }
    } catch { $canApply = $false }
  }

  $placement = Get-Placement -CardHeight ([double]$model.maxHeight)
  $card = Show-CoachCardWindow -Model $model -Placement $placement -ExcludeFromCapture ([bool]$script:State.cfg.cardExcludeFromCapture)
  $script:Active = @{
    card           = $card
    gateId         = $null
    kind           = $Kind
    gapId          = [string]$Decision.gapId
    compiled       = [string]$Decision.compiled
    followUp       = [string]$Decision.followUp
    attachment     = [string]$Decision.attachment
    smart          = [bool]$Decision.smart
    principles     = @($Decision.principles)
    principle      = [string]$Decision.principle
    rule           = if ($Decision.finding) { [string]$Decision.finding.rule } else { $null }
    sidHash        = [string]$Decision.sidHash
    ctxFilled      = $Decision.ctxFilled
    draftHash      = (Get-TextHash $Draft)
    surfaceElement = $SurfaceElement
    betterPrompt   = [string]$Decision.betterPrompt
    tags           = @($Decision.tags)
    nudgeDecision  = if ($Kind -eq 'nudge') { $Decision } else { $null }
    startedAt      = [DateTime]::UtcNow
    timer          = $null
  }
  Connect-CardActions $card $canApply
  $script:Seen[$script:Active.draftHash] = [DateTime]::UtcNow
  $script:LastCardAt = [DateTime]::UtcNow
  # Explain why rebuilds the same card; it is not a second interruption and it
  # must not spend a second budget slot. The rule lives in the learner so the
  # unit tests can hold it.
  Register-ShownCard -Kind $Kind -At $script:LastCardAt -Rebuild:$ShowWhy
  if (-not $ShowWhy) { Save-CoachStateFile }

  if ($Kind -ne 'nudge') {
    # Gap cards write shown/preview state right away. A nudge has no gap id:
    # its teaching state is the tag counters, written only on a click.
    try {
      $script:Learner = Update-LearnerState $script:Learner ([string]$Decision.gapId) 'shown'
      foreach ($principleId in @($Decision.principles)) {
        $script:Learner = Update-PrincipleState $script:Learner ([string]$principleId) 'shown'
      }
      Save-LearnerState $script:Learner
    } catch {
      Write-CoachLog ('learner shown: ' + $_.Exception.Message)
    }
  }
  Write-TraceEvent 'card_shown' @{ gap = [string]$Decision.gapId; dh = $script:Active.draftHash; kind = $Kind; hwnd = [int64]$script:Active.card.hwnd; smart = [bool]$Decision.smart; principle = [string]$Decision.principle }

  if ($script:Seen.Count -gt 800) { $script:Seen.Clear() }

  if ($AutoHideSeconds -gt 0) {
    # Script scope on purpose: a function-local captured by the tick resolves to
    # $null once Show-Card returns, and the first tick then throws on .Stop().
    # That exception escapes the dispatcher frame and takes the daemon down.
    $script:Active.timer = New-Object System.Windows.Threading.DispatcherTimer
    $script:Active.timer.Interval = [TimeSpan]::FromSeconds($AutoHideSeconds)
    $script:Active.timer.add_Tick({
      $active = $script:Active
      if (-not $active) { return }
      try {
        if ($active.timer) { $active.timer.Stop() }
        Write-TraceEvent 'card_expired' @{ gap = $active.gapId }
        Learn-IgnoredCard 'expired'
        Close-ActiveCard -Reason 'expired'
      } catch {
        Write-CoachLog ('card auto-hide: ' + $_.Exception.Message)
      }
    })
    # A countdown that keeps running under the cursor deletes a lesson
    # mid-read. Connect-HoverHold belongs with the card UI helpers
    # (Coach.Card.ps1), where window events live; the visual is inside the
    # window-info hashtable Show-CoachCardWindow returns ($card itself is
    # not a UIElement).
    Connect-HoverHold $card.window.Content $script:Active.timer
    $script:Active.timer.Start()
  }
  return $card
}

# A review is a card without a send: it never gates, never counts against the
# interruption budget, and never takes focus. The question and answer are the
# same principle the learner already accepted; the buttons are self-assessment.
function Show-ReviewCard {
  if ($script:Active) {
    try { $script:Notify.ShowBalloonTip(2500, 'Code Coach', 'Finish the current card first.', [System.Windows.Forms.ToolTipIcon]::Info) } catch { }
    return
  }
  $due = @(Get-DueReviews $script:Learner 1)
  if ($due.Count -eq 0) {
    Write-TraceEvent 'review_none' @{}
    try { $script:Notify.ShowBalloonTip(2500, 'Code Coach', 'No principle is due yet.', [System.Windows.Forms.ToolTipIcon]::Info) } catch { }
    return
  }
  $r = $due[0]
  $decision = @{
    kind          = 'review'
    gapId         = [string]$r.id
    consequence   = [string]$r.question
    gaps          = @()
    addition      = [string]$r.answer
    compiled      = $null
    followUp      = $null
    approach      = @()
    grounding     = @()
    principles    = @([string]$r.id)
    principle     = [string]$r.id
    principleName = [string]$r.name
    smart         = $false
    ctxFilled     = @{}
    finding       = $null
    lesson        = [string]$r.statement
    sidHash       = $null
  }
  $model = New-CardModel $decision 'review'
  $model.consequence = [string]$r.question
  $model.addition = [string]$r.answer
  $model.principleName = [string]$r.name
  $model.maxHeight = [double]([math]::Max(240, $script:WorkingArea.Height * 0.36))
  $placement = Get-Placement -CardHeight ([double]$model.maxHeight)
  $card = Show-CoachCardWindow -Model $model -Placement $placement -ExcludeFromCapture ([bool]$script:State.cfg.cardExcludeFromCapture)
  $script:Active = @{
    card           = $card
    gateId         = $null
    kind           = 'review'
    gapId          = [string]$r.id
    compiled       = $null
    followUp       = $null
    smart          = $false
    principles     = @([string]$r.id)
    principle      = [string]$r.id
    rule           = $null
    sidHash        = $null
    ctxFilled      = @{}
    draftHash      = $null
    surfaceElement = $null
    startedAt      = [DateTime]::UtcNow
    timer          = $null
    review         = $true
  }
  Connect-CardActions $card $false
  Write-TraceEvent 'review_shown' @{ principle = [string]$r.id }
  return $card
}

# Deciding is cheap; showing is not. The verdict goes out first and the card is
# built on the next turn, so a slow window can never delay a send.
function Get-GateDecision {
  param($Request, [switch]$NoHold)
  $mode = Get-PromptMode $script:State.cfg
  if ($mode -eq 'off') { return @{ action = 'pass'; reason = 'mode-off' } }
  if (Test-Silent) { return @{ action = 'pass'; reason = 'silent' } }

  $draft = [string]$Request.text
  $dh = Get-TextHash $draft

  # Dedupe and the 20s throttle exist to stop the same card twice. autosend has
  # no card, so it must not lose a send to either of them.
  if ($mode -eq 'review') {
    if ($script:Seen.ContainsKey($dh)) {
      $seenAt = $script:Seen[$dh]
      if ($seenAt -isnot [DateTime]) { return @{ action = 'pass'; reason = 'dedupe' } }
      if (((Get-Date).ToUniversalTime() - $seenAt.ToUniversalTime()).TotalMinutes -lt 10) { return @{ action = 'pass'; reason = 'dedupe' } }
    }
    if (((Get-Date).ToUniversalTime() - $script:LastCardAt.ToUniversalTime()).TotalSeconds -lt 20) { return @{ action = 'pass'; reason = 'throttle' } }
    if (-not (Test-HourlyBudget -Max ([int]$script:State.cfg.maxInterruptionsPerHour))) {
      Write-TraceEvent 'card_suppressed' @{ reason = 'hourly-budget'; dh = $dh }
      return @{ action = 'pass'; reason = 'hourly-budget' }
    }
  }

  $sid = [string](Get-CtxValue $Request 'sid')
  $sidHash = if ($sid) { Get-TextHash $sid } else { $null }
  $cwd = [string](Get-CtxValue $Request 'cwd')
  $rawCtx = Get-CtxValue $Request 'ctx'
  $ctx = @{}
  foreach ($name in @('Files', 'Errors', 'Tests', 'Success', 'Constraints', 'Goals', 'Attempts', 'UncommittedFiles', 'BroadAsk', 'MissingNames')) {
    $v = Get-CtxValue $rawCtx $name
    if ($v -ne $null) { $ctx[$name] = $v }
  }
  $repo = Get-RepoContext $cwd
  if ($repo) { $ctx['Repo'] = $repo }

  $mods = Get-LearnerModifiers $script:Learner
  $d = Get-SmartDecision -Draft $draft -Ctx $ctx -Learner $mods
  $d.sidHash = $sidHash
  $d.cwd = $cwd

  # Spontaneous application is the learning signal: a relevant principle was
  # already satisfied without a card. Retention is stronger: the same session
  # used a principle it accepted earlier.
  foreach ($principleId in @($d.applied)) {
    Write-TraceEvent 'principle_applied' @{ principle = [string]$principleId; src = 'prompt'; sid = $sidHash }
  }
  if ($sidHash -and $script:SessionMemory.ContainsKey($sidHash)) {
    $mem = $script:SessionMemory[$sidHash]
    if (($null -ne $mem) -and ((Get-Date).ToUniversalTime() - $mem.at.ToUniversalTime()).TotalMinutes -le 30) {
      foreach ($principleId in @($d.applied)) {
        if (@($mem.principles) -contains [string]$principleId) {
          Write-TraceEvent 'principle_retained' @{ principle = [string]$principleId; sid = $sidHash }
        }
      }
    }
  }

  if (-not $d.hold) { return @{ action = 'pass'; reason = 'no-gap'; gapId = $d.gapId; applied = $d.applied; principles = $d.principles; sidHash = $sidHash; dict = $ctx; draft = $draft } }

  if ($mode -eq 'autosend') {
    $text = [string]$d.compiled
    $attachment = [string]$d.attachment
    if ($d.smart -and $text.Trim() -and $attachment.Trim()) {
      # Attach, never replace. The plugin puts this on the outgoing request as
      # context; the developer's submitted words stay exactly as typed.
      return @{ action = 'attach'; text = $text; attachment = $attachment; gapId = $d.gapId; principle = [string]$d.principle; decision = $d; draft = $draft; sidHash = $sidHash; dict = $ctx }
    }
    # The compiler could not stay faithful, so it only has the one-sentence
    # guardrail. That is the nudge the developer rejected: send their words.
    Write-TraceEvent 'gate_unfaithful' @{ gap = [string]$d.gapId; why = [string]$d.faithful.why; dh = $dh }
    return @{ action = 'pass'; reason = 'unfaithful'; gapId = $d.gapId; sidHash = $sidHash }
  }

  if ($NoHold) {
    # A watcher card is already on screen. Compiling still happened (principles
    # were traced), but review mode has nowhere to put a second card and must
    # not park the send behind one.
    return @{ action = 'pass'; reason = 'card-busy'; gapId = $d.gapId; applied = $d.applied; principles = $d.principles; sidHash = $sidHash }
  }

  return @{ action = 'hold'; gapId = $d.gapId; addition = $d.addition; attachment = $d.attachment; decision = $d; draft = $draft; sidHash = $sidHash }
}

function Queue-Card {
  param($Decision, [string]$Kind, [string]$Draft, $SurfaceElement, [int]$AutoHideSeconds = 0, [string]$GateId)
  $script:PendingCard = @{
    decision = $Decision
    kind     = $Kind
    draft    = $Draft
    element  = $SurfaceElement
    autoHide = $AutoHideSeconds
    gateId   = $GateId
  }
  $script:CardScheduler.Stop()
  $script:CardScheduler.Start()
}

$script:CardScheduler = New-Object System.Windows.Threading.DispatcherTimer
$script:CardScheduler.Interval = [TimeSpan]::FromMilliseconds(10)
$script:CardScheduler.add_Tick({
  $script:CardScheduler.Stop()
  if (-not $script:PendingCard) { return }
  $pc = $script:PendingCard
  $script:PendingCard = $null
  # The plugin unlinks req when it stops waiting. If that happened between the
  # hold verdict and this turn, the send is already gone: pass and stay quiet.
  if (-not (Test-GateCardDue $pc $script:IpcDir)) {
    if ($pc.gateId) {
      [void](Invoke-GateFinish -State $script:Gate -IpcDir $script:IpcDir -Action 'pass')
      Write-TraceEvent 'gate_withdrawn' @{ id = $pc.gateId }
    }
    return
  }
  try {
    [void](Show-Card $pc.decision $pc.kind $pc.draft $pc.element -AutoHideSeconds ([int]$pc.autoHide) -AutoSend ([bool]$pc.gateId))
    if ($pc.gateId -and $script:Active) { $script:Active.gateId = [string]$pc.gateId }
    if ($pc.gateId) { Remove-GateRequest $script:IpcDir $pc.gateId }
  } catch {
    Write-CoachLog ('card: ' + $_.Exception.Message)
  }
})

$script:GateTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:GateTimer.Interval = [TimeSpan]::FromMilliseconds(40)
$script:GateTimer.add_Tick({
  try {
    $tick = Invoke-GateTick -State $script:Gate -IpcDir $script:IpcDir -OnExpire {
      param($id)
      if ($script:Active -and $script:Active.gateId -and $script:Active.gateId -eq $id) {
        Learn-IgnoredCard 'gate-timeout'
        Close-ActiveCard -Reason 'gate-timeout'
      }
    }
    if ($tick.timedOut) { return }

    if ($script:Active -and -not $script:Gate.active) {
      # A card is already up (watcher path). Never stack a second card, but do
      # keep compiling: autosend has no card to stack and must not be muted for
      # the 20 seconds a code card sits on screen.
      while ((Invoke-GateStart -State $script:Gate -IpcDir $script:IpcDir -OnRequest { param($req) Get-GateDecision -Request $req -NoHold }).handled) { }
      return
    }

    if (-not $script:Active -and -not $script:Gate.active) {
      $r = Invoke-GateStart -State $script:Gate -IpcDir $script:IpcDir -OnRequest { param($req) Get-GateDecision -Request $req }
      # The send is out for pass and attach alike. Triage watches the aftermath,
      # not the send path: the developer can already read the agent while the
      # triage pass skims the context digest for a lesson worth a card.
      $triageCtx = $null
      $triageDraft = ''
      $canTriage = $false
      if ($r.action -eq 'attach') {
        # It is already sent. Say so once per coach run, without a card.
        if (-not $script:AutosendNotice) {
          $script:AutosendNotice = $true
          try { $script:Notify.ShowBalloonTip(3000, 'Code Coach', 'Attached the file, finish line and check to that send. Your prompt is unchanged. Tray > Prompt mode > Review to approve each one.', [System.Windows.Forms.ToolTipIcon]::Info) } catch { }
          Write-TraceEvent 'autosend_notice' @{ gap = [string]$r.decision.gapId; principle = [string]$r.decision.principle }
        }
        $canTriage = $true
      } elseif ($r.action -eq 'pass' -and (Test-TriageEligible ([string]$r.reason))) {
        $canTriage = $true
      } elseif ($r.action -eq 'hold') {
        Queue-Card -Decision $r.decision.decision -Kind 'prompt' -Draft $r.decision.draft -GateId $r.id
        Write-TraceEvent 'gate_card' @{ id = $r.id; gap = $r.decision.gapId }
      }
      if ($canTriage) {
        $triageCtx = Get-CtxValue $r 'dict'
        $triageDraft = [string](Get-CtxValue $r 'draft')
        # Belt for a gate-start return that forgot to forward the digest: the
        # attach decision wraps them; read through it before giving up.
        if (-not $triageCtx -or -not $triageDraft) {
          $dec = Get-CtxValue $r 'decision'
          if (-not $triageCtx) { $triageCtx = Get-CtxValue $dec 'dict' }
          if (-not $triageDraft) { $triageDraft = [string](Get-CtxValue $dec 'draft') }
        }
        # An unreadable send has nothing triage can read; that is the honest
        # outcome, not a crash.
        if ($triageDraft) { Invoke-TriagePass -Draft $triageDraft -Ctx $triageCtx }
      }
    }
    # A send held by the spacing window or by an in-flight pass starts here the
    # moment the lane is free. One card at a time: while a nudge is on screen the
    # held send waits rather than replacing the lesson the developer is reading.
    if (-not $script:TriageJob -and -not $script:Active -and $script:TriagePending) {
      $held = $script:TriagePending
      $wait = ((Get-Date).ToUniversalTime() - $script:LastTriage.ToUniversalTime()).TotalSeconds
      if (((Get-Date).ToUniversalTime() - $held.at.ToUniversalTime()).TotalMinutes -ge 10) {
        $script:TriagePending = $null
        Write-TraceEvent 'triage_pending' @{ stage = 'drop'; why = 'stale' }
      } elseif ($wait -ge [double](Get-CtxValue $script:State.cfg 'triageScanSeconds')) {
        $script:TriagePending = $null
        Write-TraceEvent 'triage_pending' @{ stage = 'start'; age = [int]$wait }
        if ($held.fromHeal) { Invoke-TriagePass -Draft $held.draft -Ctx $held.ctx -FromHeal }
        else { Invoke-TriagePass -Draft $held.draft -Ctx $held.ctx }
      }
    }
    if ($script:TriageJob) {
      try { Collect-Triage } catch { Write-CoachLog ('triage: ' + $_.Exception.Message) }
    }
  } catch {
    Write-CoachLog ('gate timer: ' + $_.Exception.Message)
  }
})

# ---------------------------------------------------------------------------
# Analyzer pass: the model reads the diff off the UI thread and leaves findings
# and file briefs behind. The code pass below consumes the findings; the gate
# reads the briefs from cache. A failed pass backs off instead of retrying into
# a rate limit.
# ---------------------------------------------------------------------------
# Triage is the prompt lane's model partner: seconds, not minutes. It runs
# after the send is already out the door, and when it says yes it gets one
# nudge card with the three actions a developer knows. When it says no or times
# out, nothing shows. A send that lands while the lane is busy or inside the
# spacing window is held in one pending slot and judged when the window opens,
# so a quick second prompt is late, never invisible.
function Invoke-TriagePass {
  param([string]$Draft = '', $Ctx = $null, [switch]$FromHeal)
  if (-not [bool](Get-CtxValue $script:State.cfg 'triageEnabled')) { return }
  if ([int](Get-CtxValue $script:State.cfg 'triageMaxPerHour') -le 0) { return }
  if (Test-Silent) { return }
  # One triage at a time; replies already on the wire are not another turn.
  # The send is not discarded: it takes the pending slot and starts when the
  # lane frees. Traced, so a burst is evidence rather than a silent gap.
  if ($script:TriageJob) {
    if ($Draft) { $script:TriagePending = @{ draft = $Draft; ctx = $Ctx; fromHeal = [bool]$FromHeal; at = [DateTime]::UtcNow } }
    Write-TraceEvent 'triage_skip' @{ why = 'busy'; queued = [bool]$Draft }
    return
  }
  # Snooze outranks every other gate: the developer bought quiet hours with
  # a click, and no send interrupts them.
  if ($script:TriageSnoozeUntil -and ((Get-Date).ToUniversalTime() -lt $script:TriageSnoozeUntil)) {
    Write-TraceEvent 'triage_skip' @{ why = 'snoozed' }
    return
  }
  # Lane pick before any pool-specific rule: when the developer plugged their
  # own OpenAI-compatible provider into config, triage has its own pipe, so
  # the free-pool exclusivity rules (analyzer-busy, pipe reservation) do not
  # apply. Anything unset falls back to the legacy CLI lane.
  $apiBase   = [string](Get-CtxValue $script:State.cfg 'triageApiBase')
  $apiKeyEnv = [string](Get-CtxValue $script:State.cfg 'triageApiKeyEnv')
  $apiModel  = [string](Get-CtxValue $script:State.cfg 'triageModelName')
  $useHttp   = ($apiBase -and $apiKeyEnv -and $apiModel)
  if ($useHttp -and -not [Environment]::GetEnvironmentVariable($apiKeyEnv, 'Process')) {
    Write-TraceEvent 'triage_skip' @{ why = 'no-key'; env = $apiKeyEnv }
    return
  }
  # One model pipe on the free tier: an analyzer pass mid-flight is why the
  # triage call got a first event and then nothing for its whole budget (the
  # successful review call streamed 26KB two ticks earlier). Wait it out; this
  # does not burn the spacing window. The HTTP lane has its own pipe and
  # checks nothing here.
  if (-not $useHttp -and $script:AnalyzerJob) { Write-TraceEvent 'triage_skip' @{ why = 'analyzer-busy' }; return }
  # Backoff after any attempt is the spacing window below; there is no second
  # cooldown variable. (An earlier branch read $script:TriageNotBefore, which
  # nothing ever assigned - dead code that looked like a guard.)
  $sinceLast = ((Get-Date).ToUniversalTime() - $script:LastTriage.ToUniversalTime()).TotalSeconds
  if ($sinceLast -lt [double](Get-CtxValue $script:State.cfg 'triageScanSeconds')) {
    # Held, not dropped. The gate tick starts the latest held send as soon as
    # the window opens, so a quick second prompt still gets its own judgment.
    if ($Draft) { $script:TriagePending = @{ draft = $Draft; ctx = $Ctx; fromHeal = [bool]$FromHeal; at = [DateTime]::UtcNow } }
    Write-TraceEvent 'triage_skip' @{ why = 'spacing'; age = [int]$sinceLast; need = [int](Get-CtxValue $script:State.cfg 'triageScanSeconds'); queued = [bool]$Draft }
    return
  }
  # Two budgets, two meanings: triageMaxPerHour is the prompt lane's own cap,
  # maxInterruptionsPerHour is the global anti-nag cap every card obeys. A
  # nudge must clear both, and the trace names which one closed the door.
  if (-not (Test-TriageBudget -Max ([int](Get-CtxValue $script:State.cfg 'triageMaxPerHour')))) {
    Write-TraceEvent 'triage_skip' @{ why = 'budget'; lane = 'triage' }
    return
  }
  if (-not (Test-HourlyBudget -Max ([int](Get-CtxValue $script:State.cfg 'maxInterruptionsPerHour')))) {
    Write-TraceEvent 'triage_skip' @{ why = 'budget'; lane = 'interruptions' }
    return
  }
  if (-not $Draft -or [string]::IsNullOrWhiteSpace($Draft)) {
    Write-TraceEvent 'triage_skip' @{ why = 'empty' }
    return
  }

  $repo = Get-CtxValue $Ctx 'Repo'
  $root = if ($repo) { [string](Get-CtxValue $repo 'root') } else { '' }
  $facts = @()
  if (Get-Command Get-AnalyzerFactsForDraft -ErrorAction SilentlyContinue) {
    try { $facts = @(Get-AnalyzerFactsForDraft -Draft $Draft -Ctx $Ctx) } catch { $facts = @() }
  }
  # Without repo facts there is nothing triage can ground a claim in; better
  # quiet than a generic nag. Not entirely quiet though: if the send names
  # files that exist on disk, arm the heal — one targeted analyzer pass for
  # those files, then one retry. A retry whose facts are still missing is not
  # re-armed; one pass and one retry is the whole contract.
  if ($facts.Count -eq 0) {
    if (-not $FromHeal) {
      $targets = @(Get-TriageHealTargets -Draft $Draft -Ctx $Ctx)
      if ($targets.Count -gt 0 -and -not $script:TriageHeal) {
        $script:TriageHeal = @{
          draft       = $Draft
          ctx         = $Ctx
          root        = $root
          files       = @($targets)
          until       = [DateTime]::UtcNow.AddMinutes(10)
          passStarted = $false
        }
        Write-TraceEvent 'triage_heal' @{ stage = 'armed'; n = $targets.Count }
        return
      }
    }
    # A security-shaped ask is judgeable from the prompt and the send context
    # digest alone: "hash the password" needs no file brief. The model still
    # decides whether a card is warranted; budget and spacing still apply.
    if (-not (Test-SecurityIntent -Draft $Draft)) {
      Write-TraceEvent 'triage_skip' @{ why = 'no-facts' }
      return
    }
    Write-TraceEvent 'triage_security' @{ facts = 0 }
  }

  $promptText = New-TriagePrompt -Draft $Draft -Ctx $Ctx -RepoFacts $facts -Learner (Get-LearnerTriageProfile $script:Learner)
  # Collect-Triage checks the answer against exactly what the model was shown.
  $script:TriageMeta = @{ draft = $Draft; facts = @($facts); root = $root }
  $timeoutMs = [int](Get-CtxValue $script:State.cfg 'triageTimeoutSeconds') * 1000
  if ($useHttp) {
    Write-TraceEvent 'triage_lane' @{ lane = 'http'; model = $apiModel }
    $script:LastTriage = [DateTime]::UtcNow
    $started = Start-TriageJob -PromptText $promptText -ApiBase $apiBase -ApiKeyEnv $apiKeyEnv -ApiModel $apiModel -TimeoutMs $timeoutMs -WorkDir $root
  } else {
    $exe = Resolve-AnalyzerExe ([string](Get-CtxValue $script:State.cfg 'analyzerExe'))
    if (-not $exe) { Write-TraceEvent 'triage_skip' @{ why = 'no-cli' }; return }
    # Fallback models ride the same triage window: dead primaries fail fast
    # (a model that answers in 3 s with a key refusal leaves the budget), so
    # one healthy fallback inside the window is what makes the lane survive
    # upstream model churn.
    $fallbacks = @()
    foreach ($m in @([object[]](Get-CtxValue $script:State.cfg 'triageFallbackModels'))) { if ($m) { $fallbacks += [string]$m } }
    $timeoutMs = $timeoutMs * [Math]::Min(1 + $fallbacks.Count, 3)
    Write-TraceEvent 'triage_lane' @{ lane = 'cli'; model = [string](Get-CtxValue $script:State.cfg 'triageModel'); fallbacks = (@($fallbacks) -join '|') }
    $script:LastTriage = [DateTime]::UtcNow
    # Reserve the pipe both ways for the triage window so a fresh analyzer pass
    # cannot start behind it and queue the model call into a timeout kill. The
    # reservation must cover the job it protects, and the job budget above
    # multiplies with the candidate count - base seconds no longer cut it.
    $script:TriageReserve = [DateTime]::UtcNow.AddSeconds((2 * ([int][Math]::Round($timeoutMs / 1000.0)) + 30))
    $started = Start-TriageJob -PromptText $promptText -Exe $exe -Model ([string](Get-CtxValue $script:State.cfg 'triageModel')) -Agent ([string](Get-CtxValue $script:State.cfg 'analyzerAgent')) -FallbackModels $fallbacks -TimeoutMs $timeoutMs -WorkDir $root
  }
  if ($started) { Write-TraceEvent 'triage_started' @{ len = $promptText.Length } }
}

# The heal's own tick, run from the 5 s status tick: one targeted analyzer pass
# for the files the send named, then one triage retry once the pipe is free.
# Every wait branch just returns - the next tick re-judges. Runs after
# Invoke-AnalyzerPass so the pass that scheduled itself this tick owns the
# pipe token; a mid-flight pass never preempts real sends.
function Invoke-TriageHealTick {
  $h = $script:TriageHeal
  if (-not $h) { return }
  if ((Get-Date).ToUniversalTime() -gt $h.until) {
    Write-TraceEvent 'triage_heal' @{ stage = 'expired' }
    $script:TriageHeal = $null
    return
  }
  if (Test-Silent) { return }
  if ($script:TriageJob) { return }
  if ($script:TriageReserve -and [DateTime]::UtcNow -lt $script:TriageReserve) { return }
  if (-not $h.passStarted) {
    if ($script:AnalyzerJob) { return }
    if ([DateTime]::UtcNow -lt $script:AnalyzerNotBefore) {
      Write-TraceEvent 'triage_heal' @{ stage = 'skip'; why = 'cooldown' }
      $script:TriageHeal = $null
      return
    }
    $launch = Get-AnalyzerLaunchConfig
    if (-not $launch.exe) {
      Write-TraceEvent 'triage_heal' @{ stage = 'skip'; why = 'no-cli' }
      $script:TriageHeal = $null
      return
    }
    # The heal counts as an analyzer run: LastAnalyzer moves, so the scheduler
    # does not double-fire a second pass the moment the targeted one lands.
    $script:LastAnalyzer = [DateTime]::UtcNow
    $started = Start-AnalyzerAsync -Roots @([string]$h.root) -Exe $launch.exe `
        -Model ([string](Get-CtxValue $script:State.cfg 'analyzerModel')) `
        -Agent ([string](Get-CtxValue $script:State.cfg 'analyzerAgent')) `
        -TimeoutMs $launch.timeoutMs -MaxFiles 6 -MaxBytes $launch.maxBytes `
        -CoachRoot $script:CoachHome -CachePath (Get-AnalyzerCachePath) -IncludeFiles @($h.files)
    if ($started) {
      $h.passStarted = $true
      Write-TraceEvent 'triage_heal' @{ stage = 'pass'; n = @($h.files).Count }
    } else {
      Write-TraceEvent 'triage_heal' @{ stage = 'skip'; why = 'no-start' }
      $script:TriageHeal = $null
    }
    return
  }
  if ($script:AnalyzerJob) { return }
  # A retry only makes sense when the pass actually left a brief for a file the
  # send named. The brief call can fail on its own (timeout, rate limit) while
  # the review call lands; retrying then spends the one retry on `no-facts` and
  # teaches nothing. Check the cache first and end honestly when it is absent.
  $haveBrief = $false
  if (Get-Command Get-CachedFileBrief -ErrorAction SilentlyContinue) {
    foreach ($f in @($h.files)) {
      $brief = Get-CachedFileBrief -RelPath ([string]$f) -Root ([string]$h.root)
      if ($brief) { $haveBrief = $true; break }
    }
  }
  if (-not $haveBrief) {
    $diag = @{ stage = 'skip'; why = 'no-brief'; cache = [string](Get-AnalyzerCachePath); root = [string]$h.root; files = (@($h.files) -join ',') }
    Write-TraceEvent 'triage_heal' $diag
    $script:TriageHeal = $null
    return
  }
  # Spacing still rules the triage lane after the pass lands: if the window is
  # closed, this tick waits and a later tick re-judges. Retrying now would hand
  # the draft to Invoke-TriagePass's silent guards, which eat the one retry
  # with no trace at all - the exact death the heal exists to avoid.
  $sinceLast = ((Get-Date).ToUniversalTime() - $script:LastTriage.ToUniversalTime()).TotalSeconds
  if ($sinceLast -lt [double](Get-CtxValue $script:State.cfg 'triageScanSeconds')) { return }
  # The targeted pass landed and its briefs are in the cache (Invoke-AnalyzerPass
  # collected it). Retry once; if the facts are still missing, this is the end.
  Write-TraceEvent 'triage_heal' @{ stage = 'retry' }
  $script:TriageHeal = $null
  Invoke-TriagePass -Draft ([string]$h.draft) -Ctx $h.ctx -FromHeal
}

function Collect-Triage {
  $done = Complete-TriageJob
  if (-not $done) { return }
  $script:TriageReserve = $null
  # The lane is free the moment this returns; tests and the heal tick wait on
  # triage_idle instead of guessing how long a model takes.
  $meta = $script:TriageMeta
  $script:TriageMeta = $null
  if (-not $meta) { $meta = @{ draft = ''; facts = @(); root = '' } }
  if (-not $done.ok) {
    if ([string]$done.why -eq 'parse-fail') {
      # A named failure for a named failure: the provider answered, but never
      # with the decision contract. This used to hide inside triage_silent.
      $e = ([string]$done.error).Trim()
      Write-TraceEvent 'triage_parsefail' @{ model = ([string]$done.model); err = $e.Substring(0, [Math]::Min(120, $e.Length)) }
    } else {
      Write-TraceEvent 'triage_skip' @{ why = [string]$done.why; err = ([string]$done.error).Substring(0, [Math]::Min(120, ([string]$done.error).Length)) }
    }
    Write-TraceEvent 'triage_idle' @{ outcome = 'fail' }
    return
  }
  $t = Read-TriageResult -Text ([string]$done.text)
  if (-not $t -or -not $t.interrupt) {
    Write-TraceEvent 'triage_silent' @{ }
    Write-TraceEvent 'triage_idle' @{ outcome = 'silent' }
    return
  }
  $decision = New-TriageDecision -Result $t
  if (-not $decision) {
    Write-TraceEvent 'triage_silent' @{ }
    Write-TraceEvent 'triage_idle' @{ outcome = 'silent' }
    return
  }
  # The prompt promises the model was shown the draft, the digest and the repo
  # facts. Enforce the part that is checkable without a second model call: no
  # file or line reference the model was never given. A card that fails this is
  # dropped, not softened - a plausible invented path is the whole failure mode.
  $g = Test-TriageGrounded -Result $t -Draft ([string]$meta.draft) -Facts @($meta.facts) -Root ([string]$meta.root)
  if (-not $g.ok) {
    Write-TraceEvent 'triage_ungrounded' @{ why = [string]$g.why; detail = [string]$g.detail }
    Write-TraceEvent 'triage_idle' @{ outcome = 'ungrounded' }
    return
  }
  $decision.grounding = [string]$g.kind
  # The footer names the model that judged the draft. It is not a decoration:
  # the card must not imply local processing when the lane is a remote provider.
  if ($done.model) { $decision.model = [string]$done.model }
  Write-TraceEvent 'triage_card' @{ severity = $decision.severity; tags = (@($decision.tags) -join ','); grounding = [string]$g.kind }
  $nudgeSecs = [int](Get-CtxValue $script:State.cfg 'nudgeCardSeconds')
  if ($nudgeSecs -le 0) { $nudgeSecs = 120 }
  Queue-Card -Decision $decision -Kind 'nudge' -Draft '' -SurfaceElement $null -AutoHideSeconds $nudgeSecs
  Write-TraceEvent 'triage_idle' @{ outcome = 'card' }
}

# One place for the analyzer launch knobs so the scheduled pass and the triage
# heal's targeted pass cannot drift apart.
function Get-AnalyzerLaunchConfig {
  $exe = Resolve-AnalyzerExe ([string](Get-CtxValue $script:State.cfg 'analyzerExe'))
  $timeout = [int](Get-CtxValue $script:State.cfg 'analyzerTimeoutSeconds')
  if ($timeout -le 0) { $timeout = 90 }
  $maxBytes = [long](Get-CtxValue $script:State.cfg 'analyzerMaxContextBytes')
  if ($maxBytes -le 0) { $maxBytes = 120000 }
  return @{ exe = $exe; timeoutMs = $timeout * 1000; maxBytes = $maxBytes }
}

function Invoke-AnalyzerPass {
  if (Test-Silent) { return }
  if (-not [bool](Get-CtxValue $script:State.cfg 'analyzerEnabled')) { return }
  $roots = @($script:State.cfg.registeredRoots | Where-Object { $_ })
  if ($roots.Count -eq 0) { return }

  $done = Complete-AnalyzerAsync
  if ($done) {
    $why = [string]$done.why
    if ($why -ne 'ok') {
      $err = ([string]$done.error).Trim()
      if ($err.Length -gt 240) { $err = $err.Substring(0, 240) }
      Write-TraceEvent 'analyzer_skip' @{ why = $why; err = $err }
      if ($err) { Write-CoachLog ('analyzer: ' + $why + ' ' + $err) }
      $cool = [double](Get-CtxValue $script:State.cfg 'analyzerCooldownMinutes')
      if ($cool -le 0) { $cool = 60 }
      if ($why -in @('rate-limited', 'timeout', 'model-error', 'exception', 'no-cli')) {
        $script:AnalyzerNotBefore = [DateTime]::UtcNow.AddMinutes($cool)
      }
    }
    $found = @($done.findings | Where-Object { $_ })
    $script:AnalyzerFindings = @($found)
    $script:AnalyzerRoots = @($done.repos | Where-Object { $_ })
    $script:LastAnalyzer = [DateTime]::UtcNow
    $briefs = 0
    if ($null -ne $done.briefs) { $briefs = [int]$done.briefs }
    $briefWhy = [string]$done.briefWhy
    if ($found.Count -gt 0) {
      $ev = @{ n = $found.Count; briefs = $briefs; topics = (($found | ForEach-Object { [string]$_.topic }) -join ',') }
      if ($briefs -eq 0 -and $briefWhy) { $ev.brief_why = $briefWhy }
      Write-TraceEvent 'analyzer_ok' $ev
    } elseif ($why -eq 'ok') {
      $ev = @{ n = 0; briefs = $briefs }
      if ($briefs -eq 0 -and $briefWhy) { $ev.brief_why = $briefWhy }
      Write-TraceEvent 'analyzer_ok' $ev
    }
  }

  if ($script:AnalyzerJob) { return }
  if ([DateTime]::UtcNow -lt $script:AnalyzerNotBefore) { return }
  if ($script:TriageReserve -and [DateTime]::UtcNow -lt $script:TriageReserve) { return }
  if ($script:LastAnalyzer -ne [DateTime]::MinValue) {
    $due = $script:LastAnalyzer.AddSeconds([double](Get-CtxValue $script:State.cfg 'analyzerScanSeconds'))
    if ([DateTime]::UtcNow -lt $due) { return }
  }
  $launch = Get-AnalyzerLaunchConfig
  if (-not $launch.exe) { return }
  $script:LastAnalyzer = [DateTime]::UtcNow
  [void](Start-AnalyzerAsync -Roots $roots -Exe $launch.exe `
      -Model ([string](Get-CtxValue $script:State.cfg 'analyzerModel')) `
      -Agent ([string](Get-CtxValue $script:State.cfg 'analyzerAgent')) `
      -TimeoutMs $launch.timeoutMs -MaxFiles 6 -MaxBytes $launch.maxBytes `
      -CoachRoot $script:CoachHome -CachePath (Get-AnalyzerCachePath))
}

# ---------------------------------------------------------------------------
# Code pass: only over roots the developer registered, only for files touched
# recently, one finding per pass. The walk runs in a worker runspace; the
# status tick only starts it and collects it, so the UI thread never scans.
# ---------------------------------------------------------------------------
function Invoke-CodePass {
  if (Test-Silent) { return }
  $roots = @($script:State.cfg.registeredRoots | Where-Object { $_ })
  if ($roots.Count -eq 0) { return }
  # 0 disables the code lane. 1 is the default; there is no hidden minimum.
  $max = [int]$script:State.cfg.codeMaxFindings
  if ($max -le 0) { return }
  if ($script:Active -or $script:Gate.active) { return }

  $done = Complete-CodeScanAsync
  $ai = @($script:AnalyzerFindings)
$aiRoots = @($script:AnalyzerRoots)
if ($aiRoots.Count -eq 0) { $aiRoots = @($roots) }
  # A completed scan is one trigger; a fresh analyzer result is the other. The
  # model's findings must not wait three minutes for the next regex scan.
  if (($done -and $done.done) -or $ai.Count -gt 0) {
    if ($done -and $done.done) { $script:CodeWatermark = [DateTime]::UtcNow.AddMinutes(-1) }
    $found = @()
    if ($done -and $done.done) { $found = @($done.findings | Where-Object { $_ }) }
    # The model's findings lead: they are about this change, not this rule.
    # A finding whose line no longer exists is dropped rather than rendered.
    $candidates = New-Object System.Collections.ArrayList
    foreach ($af in $ai) {
      if (-not (Test-AnalyzerFindingLive $af $aiRoots)) { continue }
      $cf = New-AnalyzerCodeFinding $af
      if ($cf) { [void]$candidates.Add($cf) }
    }
    foreach ($f in $found) { [void]$candidates.Add($f) }
    # Consumed once. A finding suppressed by the repeat window is dropped, not
    # re-offered every five seconds.
    if ($ai.Count -gt 0) { $script:AnalyzerFindings = @() }
    $repeatHours = [double]$script:State.cfg.codeRepeatHours
    if ($repeatHours -le 0) { $repeatHours = 24 }
    $cutoff = [DateTime]::UtcNow.AddHours(-$repeatHours)
    $pick = $null
    $pickKey = $null
    foreach ($f in @($candidates)) {
      $key = 'code|' + [string]$f.rule + '|' + (Get-CodeHash ([string]$f.file + ':' + [string]$f.line))
      if ($script:SeenCode.ContainsKey($key)) {
        if ($script:SeenCode[$key] -ge $cutoff) {
          # Already shown inside the window. Trace it once per process so the
          # dedupe is visible, but do not interrupt again.
          if (-not $script:Seen.ContainsKey($key)) {
            $script:Seen[$key] = $true
            Write-TraceEvent 'code_repeat' (Get-CodeFindingTrace $f)
          }
          continue
        }
        $script:SeenCode.Remove($key)
        [void](Save-CodeSeen $script:SeenCodePath $script:SeenCode $repeatHours)
      }
      $pick = $f
      $pickKey = $key
      break
    }
    if ($pick) {
      $script:SeenCode[$pickKey] = [DateTime]::UtcNow
      [void](Save-CodeSeen $script:SeenCodePath $script:SeenCode $repeatHours)
      $lesson = Get-NextLesson $script:Learner ([string]$pick.gapId)
      $d = New-CodeDecision $pick $lesson
      $autoHide = [int]$script:State.cfg.codeCardSeconds
      if ($autoHide -le 0) { $autoHide = 20 }
      Queue-Card -Decision $d -Kind 'code' -Draft '' -SurfaceElement $null -AutoHideSeconds $autoHide
      Write-TraceEvent 'code_finding' (Get-CodeFindingTrace $pick)
    }
  }

  if ($script:CodeScanJob) { return }
  if ($script:LastCodeScan -ne [DateTime]::MinValue) {
    $due = $script:LastCodeScan.AddSeconds([double]$script:State.cfg.codeScanSeconds)
    if ([DateTime]::UtcNow -lt $due) { return }
  }
  $max = [int]$script:State.cfg.codeMaxFindings
  $script:LastCodeScan = [DateTime]::UtcNow
  # Ask for headroom: the newest few findings may all be repeats inside the
  # repeat window, and one repeat must not hide a fresh finding behind it.
  [void](Start-CodeScanAsync -Roots $roots -SinceUtc $script:CodeWatermark -Max ([Math]::Max(5, $max)) -ExcludePaths @($script:CoachHome))
}
# ---------------------------------------------------------------------------
# Watcher: focus events, debounced, allowlisted, read through UIA only.
# ---------------------------------------------------------------------------
$script:Debounce = New-Object System.Windows.Threading.DispatcherTimer
$script:Debounce.Interval = [TimeSpan]::FromMilliseconds(700)
$script:Debounce.add_Tick({
  $script:Debounce.Stop()
  try {
    if (Test-Silent) { return }
    if (-not $script:State.cfg.watchSurfaces) { return }
    if ($script:Active) { return }

    $surface = Get-FocusedSurface
    if (-not $surface) { return }
    $info = $surface.info
    # opencode is the plugin lane. Reading its composer through UIA is the
    # context-blind path that produced the old duplicate cards.
    if ([string]$info.process -match '(?i)^opencode' -or
        [string]$info.windowTitle -match '(?i)\bopencode\b') { return }
    if (-not $surface.verdict.accept) {
      $key = ('{0}|{1}' -f [string]$info.process, [string]$surface.verdict.why)
      $last = [DateTime]::MinValue
      if ($script:LastRejected.ContainsKey($key)) { $last = $script:LastRejected[$key] }
      if (((Get-Date) - $last).TotalSeconds -gt 60) {
        $script:LastRejected[$key] = Get-Date
        Write-TraceEvent 'surface_rejected' @{ process = [string]$info.process; why = [string]$surface.verdict.why }
      }
      return
    }

    $read = Get-TextFromElement $surface.element
    if (-not $read.ok) {
      Write-TraceEvent 'read_failed' @{ why = $read.why; process = [string]$info.process }
      return
    }
    $text = if ($surface.verdict.kind -eq 'terminal') { Get-ComposerLine ([string]$read.text) } else { ([string]$read.text).Trim() }
    if (-not (Test-DraftLike $text)) { return }

    $dh = Get-TextHash $text
    if ($script:Seen.ContainsKey($dh)) { return }
    if (((Get-Date).ToUniversalTime() - $script:LastCardAt.ToUniversalTime()).TotalSeconds -lt 20) { return }
    if (-not (Test-HourlyBudget -Max ([int]$script:State.cfg.maxInterruptionsPerHour))) { return }

    Write-TraceEvent 'surface_accepted' @{ process = [string]$info.process; kind = $surface.verdict.kind; len = $text.Length }

    $mods = Get-LearnerModifiers $script:Learner
    $d = Get-HoldDecision -Draft $text -Ctx $null -Learner $mods
    if (-not $d.hold) { return }

    # The card attaches context. The developer's words are never replaced.
    $surfaceSecs = [int](Get-CtxValue $script:State.cfg 'surfaceCardSeconds')
    if ($surfaceSecs -le 0) { $surfaceSecs = 30 }
    Queue-Card -Decision $d -Kind $surface.verdict.kind -Draft $text -SurfaceElement $surface.element -AutoHideSeconds $surfaceSecs
    Write-TraceEvent 'card_before_send' @{ gap = $d.gapId; dh = $dh }
  } catch {
    Write-CoachLog ('watcher: ' + $_.Exception.Message)
  }
})

$script:FocusHandler = [System.Windows.Automation.AutomationFocusChangedEventHandler]{
  param($sender, $e)
  try {
    $script:Ui.BeginInvoke([Action]{
      $script:Debounce.Stop()
      $script:Debounce.Start()
    }) | Out-Null
  } catch { }
}

try {
  [System.Windows.Automation.Automation]::AddAutomationFocusChangedEventHandler($script:FocusHandler)
} catch {
  Write-CoachLog ('watcher: focus subscription failed: ' + $_.Exception.Message)
}

# ---------------------------------------------------------------------------
# Tray
# ---------------------------------------------------------------------------
function Get-StatusText {
  if (Test-CoachKilled) { return 'Code Coach - stopped (KILL)' }
  if ($script:State.paused) { return 'Code Coach - paused' }
  if (-not $script:State.cfg.watchSurfaces) { return 'Code Coach - gate only' }
  return 'Code Coach - watching'
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.Text = Get-StatusText
$notify.Visible = $true
$script:Notify = $notify

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$itemWatch = New-Object System.Windows.Forms.ToolStripMenuItem
$itemWatch.Text = 'Watch terminals and IDE chat'
$itemWatch.CheckOnClick = $true
$itemWatch.Checked = [bool](Get-CoachConfig).watchSurfaces
$itemWatch.add_Click({
  $c = Get-CoachConfig
  $c.watchSurfaces = [bool]$itemWatch.Checked
  Save-CoachConfig $c
  $script:State.cfg = $c
  $notify.Text = Get-StatusText
  Write-TraceEvent 'watch_toggle' @{ on = [bool]$c.watchSurfaces }
})

$itemCapture = New-Object System.Windows.Forms.ToolStripMenuItem
$itemCapture.Text = 'Capture measurements'
$itemCapture.CheckOnClick = $true
$itemCapture.Checked = [bool]$script:State.capture
$itemCapture.add_Click({
  $c = Get-CoachConfig
  $c.capture = [bool]$itemCapture.Checked
  Save-CoachConfig $c
  $script:State.capture = [bool]$c.capture
  $notify.Text = Get-StatusText
  Write-TraceEvent 'capture' @{ on = [bool]$c.capture }
})

$itemMode = New-Object System.Windows.Forms.ToolStripMenuItem
$itemMode.Text = 'Prompt mode'
$modeNow = Get-PromptMode (Get-CoachConfig)
foreach ($spec in @(
  @{ key = 'autosend'; text = 'Improve every prompt' },
  @{ key = 'review';   text = 'Ask before each prompt' },
  @{ key = 'off';      text = 'Leave my prompts alone' }
)) {
  $mi = New-Object System.Windows.Forms.ToolStripMenuItem
  $mi.Text = [string]$spec.text
  $mi.CheckOnClick = $false
  $mi.Tag = [string]$spec.key
  $mi.Checked = ($modeNow -eq [string]$spec.key)
  $mi.add_Click({
    $key = [string]$this.Tag
    $c = Get-CoachConfig
    $c.promptMode = $key
    Save-CoachConfig $c
    $script:State.cfg = $c
    foreach ($entry in $itemMode.DropDownItems) {
      if ($entry -is [System.Windows.Forms.ToolStripMenuItem]) { $entry.Checked = ([string]$entry.Tag -eq $key) }
    }
    $notify.Text = Get-StatusText
    Write-TraceEvent 'prompt_mode' @{ mode = $key }
  })
  [void]$itemMode.DropDownItems.Add($mi)
}

$itemPause1h = New-Object System.Windows.Forms.ToolStripMenuItem
$itemPause1h.Text = 'Pause for 1 hour'
$itemPause1h.add_Click({
  $c = Get-CoachConfig
  $c.pauseUntil = [DateTimeOffset]::UtcNow.AddHours(1).ToString('o')
  Save-CoachConfig $c
  $script:State.paused = $true
  $notify.Text = Get-StatusText
  Write-TraceEvent 'pause' @{ minutes = 60 }
})

$itemPauseRestart = New-Object System.Windows.Forms.ToolStripMenuItem
$itemPauseRestart.Text = 'Pause until restart'
$itemPauseRestart.add_Click({
  $script:State.paused = $true
  $notify.Text = Get-StatusText
  Write-TraceEvent 'pause' @{ until_restart = $true }
})

$itemResume = New-Object System.Windows.Forms.ToolStripMenuItem
$itemResume.Text = 'Resume'
$itemResume.add_Click({
  $c = Get-CoachConfig
  $c.pauseUntil = $null
  Save-CoachConfig $c
  $script:State.paused = $false
  $notify.Text = Get-StatusText
  Write-TraceEvent 'resume' @{}
})

$itemReview = New-Object System.Windows.Forms.ToolStripMenuItem
$itemReview.Text = 'Review due principle'
$itemReview.add_Click({
  try { Show-ReviewCard | Out-Null } catch { Write-CoachLog ('review: ' + $_.Exception.Message) }
})

$itemInsights = New-Object System.Windows.Forms.ToolStripMenuItem
$itemInsights.Text = 'Open insights'
$itemInsights.add_Click({
  try {
    $r = New-InsightsPage -TraceFile $script:TracePath -State (Get-LearnerState)
    Start-Process $r.path
  } catch { Write-CoachLog ('insights: ' + $_.Exception.Message) }
})

$itemData = New-Object System.Windows.Forms.ToolStripMenuItem
$itemData.Text = 'Open data folder'
$itemData.add_Click({ Start-Process explorer.exe $script:CoachData })

$itemLogs = New-Object System.Windows.Forms.ToolStripMenuItem
$itemLogs.Text = 'Open coach log'
$itemLogs.add_Click({
  if (Test-Path -LiteralPath $script:LogPath) { Start-Process notepad.exe $script:LogPath }
})

$itemQuit = New-Object System.Windows.Forms.ToolStripMenuItem
$itemQuit.Text = 'Quit'
$itemQuit.add_Click({
  Write-TraceEvent 'daemon_stopped' @{ reason = 'tray-quit' }
  $notify.Visible = $false
  $script:UiFrame.Continue = $false
})

[void]$menu.Items.Add($itemWatch)
[void]$menu.Items.Add($itemCapture)
[void]$menu.Items.Add($itemMode)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($itemPause1h)
[void]$menu.Items.Add($itemPauseRestart)
[void]$menu.Items.Add($itemResume)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($itemReview)
[void]$menu.Items.Add($itemInsights)
[void]$menu.Items.Add($itemData)
[void]$menu.Items.Add($itemLogs)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($itemQuit)
$notify.ContextMenuStrip = $menu

$script:StatusTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:StatusTimer.Interval = [TimeSpan]::FromSeconds(5)
$script:StatusTimer.add_Tick({
  Set-StateFromConfig
  $notify.Text = Get-StatusText
  [void](Clear-GateFiles -IpcDir $script:IpcDir -MaxAgeMin 2)
  Invoke-AnalyzerPass
  Invoke-TriageHealTick
  Invoke-CodePass
})

# Readiness is announced from a timer tick, so it means the loop is pumping.
$script:ReadyTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:ReadyTimer.Interval = [TimeSpan]::FromMilliseconds(10)
$script:ReadyTimer.add_Tick({
  $script:ReadyTimer.Stop()
  Write-TraceEvent 'daemon_ready' @{ pid = $PID }
})

$script:GateTimer.Start()
$script:StatusTimer.Start()
$script:ReadyTimer.Start()

try {
  [System.Windows.Threading.Dispatcher]::PushFrame($script:UiFrame)
} finally {
  $script:GateTimer.Stop()
  $script:StatusTimer.Stop()
  $script:ReadyTimer.Stop()
  $script:Debounce.Stop()
  try { [System.Windows.Automation.Automation]::RemoveAutomationFocusChangedEventHandler($script:FocusHandler) } catch { }
  Close-ActiveCard -Reason 'shutdown'
  try { if (Test-Path -LiteralPath $script:PidPath) { Remove-Item -LiteralPath $script:PidPath -Force } } catch { }
  $notify.Visible = $false
  $notify.Dispose()
  if ($mutex) { try { $mutex.ReleaseMutex() } catch { }; $mutex.Dispose() }
  Write-CoachLog 'daemon: stopped'
}
