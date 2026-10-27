# Run-Minimal.ps1 - live end-to-end test for the slice-1 gate.
#
# Starts the real daemon in a child process and writes the same req-<id>.json
# the plugin writes. The plugin never waits for an answer, so this test asserts
# what the developer can actually observe:
#
#   card     - a destructive ask with no recovery point shows one card
#   copy     - "Copy the guardrail" puts the guardrail on the clipboard
#   dismiss  - "Dismiss" closes the card without touching the clipboard
#   silent   - a non-destructive ask, or a destructive ask with a recovery
#              point, shows no card at all
#   one      - a second destructive ask while a card is up is dropped, not stacked
#   stale    - a request older than the limit is dropped without a card
#   quiet    - no prompt text reaches daemon.log or trace.jsonl
#   guard    - a second daemon on the same folder refuses to start
#   stop     - the stop file closes the card and removes the pid file
#
# Windows only, like the daemon. Exits non-zero if any check fails.

param([switch]$Keep)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$root = Split-Path -Parent $PSScriptRoot
$daemon = Join-Path $root 'src\Coach.Daemon.ps1'
if (-not (Test-Path -LiteralPath $daemon)) { throw "missing $daemon" }

$data = Join-Path ([System.IO.Path]::GetTempPath()) ('cc-gate-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$ipc = Join-Path $data 'ipc'
$log = Join-Path $data 'logs\daemon.log'
$trace = Join-Path $data 'trace.jsonl'
$pidFile = Join-Path $data 'daemon.pid'
New-Item -ItemType Directory -Force -Path $ipc | Out-Null

$utf8 = New-Object System.Text.UTF8Encoding($false)
$checks = 0
$fails = 0

function Check([string]$Name, [bool]$Ok, [string]$Detail = '') {
  $script:checks++
  if ($Ok) {
    Write-Output ('[PASS] ' + $Name)
  } else {
    $script:fails++
    if ($Detail) { Write-Output ('[FAIL] ' + $Name + ' :: ' + $Detail) }
    else { Write-Output ('[FAIL] ' + $Name) }
  }
}

function Write-Req([string]$Text, [int]$AgeSeconds = 0) {
  $id = [guid]::NewGuid().ToString()
  $payload = @{ id = $id; text = $Text; cwd = 'C:\repo'; sid = 's-live'; at = 0 } | ConvertTo-Json -Compress
  $path = Join-Path $ipc ('req-' + $id + '.json')
  $tmp = $path + '.tmp'
  [System.IO.File]::WriteAllText($tmp, $payload, $utf8)
  if ($AgeSeconds -gt 0) { (Get-Item -LiteralPath $tmp).LastWriteTime = (Get-Date).AddSeconds(-$AgeSeconds) }
  Move-Item -LiteralPath $tmp -Destination $path -Force
  return $id
}

function Wait-Gone([string]$Id, [int]$Milliseconds = 3000) {
  $path = Join-Path $ipc ('req-' + $Id + '.json')
  $until = (Get-Date).AddMilliseconds($Milliseconds)
  while ((Get-Date) -lt $until) {
    if (-not (Test-Path -LiteralPath $path)) { return $true }
    Start-Sleep -Milliseconds 30
  }
  return $false
}

function Find-Cards() {
  $rootEl = [System.Windows.Automation.AutomationElement]::RootElement
  $idCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'CodeCoachGateCard')
  return @($rootEl.FindAll([System.Windows.Automation.TreeScope]::Children, $idCond))
}

function Wait-Card([int]$Milliseconds = 3000) {
  $until = (Get-Date).AddMilliseconds($Milliseconds)
  while ((Get-Date) -lt $until) {
    $cards = Find-Cards
    if ($cards.Count -gt 0) { return $cards[0] }
    Start-Sleep -Milliseconds 50
  }
  return $null
}

function Wait-CardGone([int]$Milliseconds = 3000) {
  $until = (Get-Date).AddMilliseconds($Milliseconds)
  while ((Get-Date) -lt $until) {
    if ((Find-Cards).Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 50
  }
  return $false
}

function Invoke-CardButton($Card, [string]$AutomationId) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $AutomationId)
  $button = $Card.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if (-not $button) { return $false }
  $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $pattern.Invoke()
  return $true
}

function Read-Clipboard() {
  try { return [System.Windows.Clipboard]::GetText() } catch { return '' }
}

function Set-ClipboardSafe([string]$Text) {
  try { [System.Windows.Clipboard]::SetText($Text); return $true } catch { return $false }
}

$previous = $env:COACH_DATA_DIR
$env:COACH_DATA_DIR = $data
$daemonArgs = '-NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File "' + $daemon + '"'
$proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $daemonArgs -PassThru -WindowStyle Hidden
$env:COACH_DATA_DIR = $previous

try {
  $until = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $until -and -not (Test-Path -LiteralPath $pidFile)) { Start-Sleep -Milliseconds 100 }
  Check 'daemon wrote its pid file' (Test-Path -LiteralPath $pidFile)
  Check 'daemon process is alive' (-not $proc.HasExited)
  if ($proc.HasExited) { throw 'daemon exited before the first request' }

  # 1. destructive ask -> one card
  $id = Write-Req 'delete all the logs from last week'
  $card = Wait-Card 4000
  Check 'destructive ask shows a card' ($null -ne $card)
  Check 'the request is consumed' (Wait-Gone $id 2000)
  Check 'exactly one card' ((Find-Cards).Count -eq 1) (([string](Find-Cards).Count) + ' cards')

  # 2. copy the guardrail
  $sentinel = 'coach-test-sentinel-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
  Check 'clipboard can be seeded' (Set-ClipboardSafe $sentinel)
  $clicked = if ($card) { Invoke-CardButton $card 'CoachCopyGuardrail' } else { $false }
  Check 'Copy the guardrail clicked' $clicked
  Start-Sleep -Milliseconds 200
  $clip = Read-Clipboard
  Check 'clipboard holds the guardrail' ($clip -like 'Before you delete or rewrite anything*') $clip
  Check 'clipboard replaced the sentinel' ($clip -ne $sentinel)
  Check 'card closed after the copy' (Wait-CardGone 3000)

  # 3. a non-destructive ask stays silent
  $id = Write-Req 'summarize the current state of the parser'
  Check 'non-destructive request is consumed' (Wait-Gone $id 3000)
  Check 'non-destructive ask shows no card' ((Find-Cards).Count -eq 0)

  # 4. a destructive ask with a recovery point stays silent
  $id = Write-Req 'delete the old logs after committing the current state first'
  Check 'guarded request is consumed' (Wait-Gone $id 3000)
  Check 'guarded destructive ask shows no card' ((Find-Cards).Count -eq 0)

  # 5. dismiss does not touch the clipboard
  $id = Write-Req 'wipe the cache directory completely'
  $card = Wait-Card 4000
  Check 'second destructive ask shows a card' ($null -ne $card)
  Check 'clipboard can be re-seeded' (Set-ClipboardSafe $sentinel)
  $clicked = if ($card) { Invoke-CardButton $card 'CoachDismiss' } else { $false }
  Check 'Dismiss clicked' $clicked
  Check 'card closed after dismiss' (Wait-CardGone 3000)
  Start-Sleep -Milliseconds 150
  Check 'dismiss left the clipboard alone' ((Read-Clipboard) -eq $sentinel)

  # 6. a second destructive ask while a card is up is dropped, not stacked
  $idA = Write-Req 'reset the database to a clean state'
  $card = Wait-Card 4000
  Check 'card is up before the second ask' ($null -ne $card)
  $idB = Write-Req 'drop the users table'
  Check 'second request is consumed' (Wait-Gone $idB 3000)
  Check 'still exactly one card' ((Find-Cards).Count -eq 1) (([string](Find-Cards).Count) + ' cards')
  if ($card) { [void](Invoke-CardButton $card 'CoachDismiss') }
  Check 'card closes after the drop' (Wait-CardGone 3000)

  # 7. a stale request is dropped without a card
  $id = Write-Req 'delete all the logs from last week' 600
  Check 'stale request is consumed' (Wait-Gone $id 3000)
  Check 'stale request shows no card' ((Find-Cards).Count -eq 0)

  # 8. pid guard
  $env:COACH_DATA_DIR = $data
  $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $daemon 2>&1
  $code = $LASTEXITCODE
  $env:COACH_DATA_DIR = $previous
  Check 'guard: second daemon exits 2' ($code -eq 2) ('exit ' + $code)
  Check 'guard: second daemon names the running pid' (($out -join "`n") -match 'refused: daemon \d+ is already running')

  # 9. quiet + trace
  $requests = @(Get-ChildItem -LiteralPath $ipc -Filter 'req-*.json' -File -ErrorAction SilentlyContinue)
  Check 'no request files left behind' ($requests.Count -eq 0) ($requests.Count.ToString() + ' left')
  $logText = if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Raw } else { '' }
  $traceText = if (Test-Path -LiteralPath $trace) { Get-Content -LiteralPath $trace -Raw } else { '' }
  $secrets = @(
    'delete all the logs from last week',
    'summarize the current state of the parser',
    'delete the old logs after committing the current state first',
    'wipe the cache directory completely',
    'reset the database to a clean state',
    'drop the users table'
  )
  $leaked = @($secrets | Where-Object { $logText -like ('*' + $_ + '*') -or $traceText -like ('*' + $_ + '*') })
  Check 'no prompt text in daemon.log or trace.jsonl' ($leaked.Count -eq 0) ($leaked -join ' | ')

  $actions = @()
  foreach ($line in @($traceText -split '\r?\n')) {
    if (-not $line) { continue }
    try { $ev = $line | ConvertFrom-Json; if ($ev.ev) { $actions += [string]$ev.ev } } catch { }
  }
  Check 'trace records a shown card' ($actions -contains 'card_shown')
  Check 'trace records a copied guardrail' ($actions -contains 'card_action')
  Check 'trace records the dropped second card' ($actions -contains 'card_dropped')
  Check 'trace records the stale request' ($actions -contains 'request_stale')

  # 10. graceful stop
  [System.IO.File]::WriteAllText((Join-Path $data 'stop'), 'stop', $utf8)
  $exited = $proc.WaitForExit(5000)
  Check 'stop: daemon exits on the stop file' $exited
  Check 'stop: pid file removed' (-not (Test-Path -LiteralPath $pidFile))
} finally {
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  if ($Keep) { Write-Output ('data kept: ' + $data) }
  else { Remove-Item -LiteralPath $data -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Output ''
Write-Output ('checks: ' + $checks + '  failed: ' + $fails)
if ($fails -gt 0) { exit 1 }
Write-Output 'minimal gate: PASS'
