# Coach.Gate.ps1 - the opencode IPC server, speaking the contract in docs/IPC.md.
# Contract: req-<id>.json in, res-<id>.json verdict, dec-<id>.json decision.
# Fail open everywhere: any doubt answers "pass" and the send proceeds.

# These are one half of a two-process contract. The other half is
# plugin/code-coach/index.js: VERDICT_MS (1500) and DECISION_MS (5000).
# The daemon must answer a verdict before the plugin gives up, and must never
# gate a request the plugin has already withdrawn.
$script:GateHoldBudgetMs = 4000
$script:GateStaleMs = 1200
$script:GateFileMaxAgeMin = 2

function Get-GateId([string]$FileName) {
  $name = [IO.Path]::GetFileNameWithoutExtension($FileName)
  if ($name.Length -le 4) { return $null }
  return $name.Substring(4)
}

# The plugin deletes its req when it stops waiting. That unlink is the cancel
# signal: if it is gone, no card may be shown for that request.
function Test-GateRequestLive {
  param([string]$IpcDir, [string]$Id)
  if (-not $Id) { return $false }
  return (Test-Path -LiteralPath (Join-Path $IpcDir ('req-' + $Id + '.json')))
}

function Remove-GateRequest {
  param([string]$IpcDir, [string]$Id)
  if (-not $Id) { return }
  try { Remove-Item -LiteralPath (Join-Path $IpcDir ('req-' + $Id + '.json')) -Force -ErrorAction SilentlyContinue } catch { }
}

# A queued card may only be shown if its request is still waiting. Cards that
# did not come from the gate (code, watcher) have no gate id and always show.
function Test-GateCardDue {
  param($PendingCard, [string]$IpcDir)
  if (-not $PendingCard) { return $false }
  if (-not $PendingCard.gateId) { return $true }
  return (Test-GateRequestLive $IpcDir ([string]$PendingCard.gateId))
}

function Test-GateTextUsable([string]$Text) {
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  $t = $Text.Trim()
  if ($t.Length -lt 12 -or $t.Length -gt 4000) { return $false }
  if ($t.StartsWith('/')) { return $false }
  return $true
}

function Write-GateFile([string]$IpcDir, [string]$Name, $Object) {
  try {
    if (-not (Test-Path -LiteralPath $IpcDir)) { New-Item -ItemType Directory -Force -Path $IpcDir | Out-Null }
    $p = Join-Path $IpcDir $Name
    $tmp = $p + '.tmp'
    $json = $Object | ConvertTo-Json -Compress -Depth 5
    [IO.File]::WriteAllText($tmp, $json, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $p -Force
    return $true
  } catch {
    Write-CoachLog ('gate: write failed ' + $Name + ' - ' + $_.Exception.Message)
    return $false
  }
}

function Write-GateVerdict([string]$IpcDir, [string]$Id, [string]$Action, [string]$Text, [string]$Attachment) {
  $body = @{ id = $Id; action = $Action }
  if ($Action -eq 'attach' -and -not [string]::IsNullOrEmpty($Text)) {
    $body = @{ id = $Id; action = $Action; text = $Text }
    if (-not [string]::IsNullOrEmpty($Attachment)) {
      $body.attachment = $Attachment
    }
  }
  return (Write-GateFile $IpcDir ('res-' + $Id + '.json') $body)
}

function Write-GateDecision([string]$IpcDir, [string]$Id, [string]$Action, [string]$Text, [string]$Attachment) {
  if ($Action -eq 'attach' -and -not [string]::IsNullOrEmpty($Text)) {
    $body = @{ id = $Id; action = $Action; text = $Text }
    if (-not [string]::IsNullOrEmpty($Attachment)) {
      $body.attachment = $Attachment
    }
    return (Write-GateFile $IpcDir ('dec-' + $Id + '.json') $body)
  }
  return (Write-GateFile $IpcDir ('dec-' + $Id + '.json') @{ id = $Id; action = 'pass' })
}

function New-GateState { return @{ active = $null } }

# Pick the oldest unanswered request and answer its verdict.
function Invoke-GateStart {
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][string]$IpcDir,
    [scriptblock]$OnRequest
  )

  if ($State.active) { return @{ handled = $false; reason = 'busy' } }
  if (-not (Test-Path -LiteralPath $IpcDir)) { return @{ handled = $false; reason = 'no-folder' } }

  $files = @(Get-ChildItem -LiteralPath $IpcDir -Filter 'req-*.json' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime)
  foreach ($f in $files) {
    $id = Get-GateId $f.Name
    if (-not $id) { continue }
    if (Test-Path -LiteralPath (Join-Path $IpcDir ('res-' + $id + '.json'))) { continue }

    $req = Read-JsonFile $f.FullName
    $ageMs = ([DateTime]::UtcNow - $f.LastWriteTimeUtc).TotalMilliseconds

    if (-not $req) {
      [void](Write-GateVerdict $IpcDir $id 'pass')
      Remove-GateRequest $IpcDir $id
      Write-TraceEvent 'gate_pass' @{ reason = 'unreadable'; id = $id }
      return @{ handled = $true; id = $id; action = 'pass'; reason = 'unreadable' }
    }

    if ($ageMs -gt $script:GateStaleMs) {
      [void](Write-GateVerdict $IpcDir $id 'pass')
      Remove-GateRequest $IpcDir $id
      Write-TraceEvent 'gate_pass' @{ reason = 'stale'; id = $id; age_ms = [int]$ageMs }
      return @{ handled = $true; id = $id; action = 'pass'; reason = 'stale' }
    }

    if (-not (Test-GateTextUsable ([string]$req.text))) {
      [void](Write-GateVerdict $IpcDir $id 'pass')
      Remove-GateRequest $IpcDir $id
      Write-TraceEvent 'gate_pass' @{ reason = 'text-shape'; id = $id; len = ([string]$req.text).Length }
      return @{ handled = $true; id = $id; action = 'pass'; reason = 'text-shape' }
    }

    $decision = $null
    if ($OnRequest) { $decision = & $OnRequest $req }
    $action = 'pass'
    if ($decision) {
      if ($decision.action) { $action = [string]$decision.action }
      elseif ($decision.hold) { $action = 'hold' }
    }

    # The compiler answered with earned context. Hand it back in the verdict:
    # the plugin attaches it to the send immediately, so the send is never
    # delayed, the card is not in the path, and the developer's text is not
    # rewritten.
    if ($action -eq 'attach' -and -not [string]::IsNullOrWhiteSpace([string]$decision.text)) {
      $text = [string]$decision.text
      $attachment = [string]$decision.attachment
      if ([string]::IsNullOrWhiteSpace($attachment)) {
        # No context body means there is nothing to attach. Never park a send
        # behind an empty verdict.
        $action = 'pass'
      } else {
        [void](Write-GateVerdict $IpcDir $id $action $text $attachment)
        Remove-GateRequest $IpcDir $id
        Write-TraceEvent 'gate_autosend' @{ id = $id; gap = $decision.gapId; principle = $decision.principle; len = $text.Length; delivery = $action }
        # Same contract as the pass return: the post-send lane (triage) reads
        # the request's draft and context digest from the gate-start return.
        return @{ handled = $true; id = $id; action = $action; decision = $decision; dict = $decision.dict; draft = $decision.draft }
      }
    }

    $hold = ($action -eq 'hold')

    if ($hold) {
      [void](Write-GateVerdict $IpcDir $id 'hold')
      $State.active = @{
        id = $id
        req = $req
        started = [DateTimeOffset]::UtcNow
        deadline = [DateTimeOffset]::UtcNow.AddMilliseconds($script:GateHoldBudgetMs)
        compiled = $decision.compiled
        attachment = $decision.attachment
      }
      Write-TraceEvent 'gate_hold' @{ id = $id; gap = $decision.gapId; len = ([string]$req.text).Length }
      return @{ handled = $true; id = $id; action = 'hold'; decision = $decision }
    }

    [void](Write-GateVerdict $IpcDir $id 'pass')
    Remove-GateRequest $IpcDir $id
    # The compile was done in the callback; its reason travels through, and the
    # post-send lane (triage) needs the request's draft and context digest to
    # know what was just sent. Empty dict/draft mean no callback ran.
    $reason = ''
    if ($decision) { $reason = [string]$decision.reason }
    if (-not $reason) { $reason = 'no-gap' }
    Write-TraceEvent 'gate_pass' @{ reason = $reason; id = $id }
    return @{ handled = $true; id = $id; action = 'pass'; reason = $reason; dict = $decision.dict; draft = $decision.draft }
  }

  return @{ handled = $false; reason = 'no-request' }
}

function Invoke-GateFinish {
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][string]$IpcDir,
    [Parameter(Mandatory = $true)][ValidateSet('attach', 'pass')][string]$Action,
    [string]$Text,
    [string]$Attachment
  )
  if (-not $State.active) { return @{ ok = $false; reason = 'no-active-gate' } }
  $id = $State.active.id
  $ok = Write-GateDecision $IpcDir $id $Action $Text $Attachment
  $State.active = $null
  Remove-GateRequest $IpcDir $id
  Write-TraceEvent 'gate_decision' @{ id = $id; action = $Action; len = if ($Text) { $Text.Length } else { 0 } }
  return @{ ok = $ok; id = $id; action = $Action }
}

# Called on a timer. If the card outlives its budget, step aside and let the send go.
function Invoke-GateTick {
  param([Parameter(Mandatory = $true)]$State, [Parameter(Mandatory = $true)][string]$IpcDir, [scriptblock]$OnExpire)
  if (-not $State.active) { return @{ timedOut = $false } }
  if ([DateTimeOffset]::UtcNow -lt $State.active.deadline) { return @{ timedOut = $false } }
  $id = $State.active.id
  $waitMs = ([DateTimeOffset]::UtcNow - $State.active.started).TotalMilliseconds
  $State.active = $null
  # The card has to be off screen before the pass lands, or the model request
  # starts while the developer is still looking at a card for that send.
  if ($OnExpire) { & $OnExpire $id }
  [void](Write-GateDecision $IpcDir $id 'pass' $null)
  Remove-GateRequest $IpcDir $id
  Write-TraceEvent 'gate_timeout' @{ id = $id; waited_ms = [int]$waitMs }
  return @{ timedOut = $true; id = $id; waited_ms = [int]$waitMs }
}

# Housekeeping: the plugin deletes req files; res and dec are ours to clean up.
function Clear-GateFiles {
  param([Parameter(Mandatory = $true)][string]$IpcDir, [int]$MaxAgeMin = $script:GateFileMaxAgeMin)
  if (-not (Test-Path -LiteralPath $IpcDir)) { return 0 }
  $cut = [DateTime]::UtcNow.AddMinutes(-$MaxAgeMin)
  $n = 0
  foreach ($f in @(Get-ChildItem -LiteralPath $IpcDir -File -ErrorAction SilentlyContinue)) {
    if ($f.LastWriteTimeUtc -lt $cut) {
      try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop; $n++ } catch { }
    }
  }
  return $n
}

function Get-GateFolder {
  return (Join-Path $script:CoachData 'ipc')
}
