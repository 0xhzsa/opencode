# Run-Minimal.ps1 - live end-to-end test for the slice-1 gate.
#
# Starts the real daemon in a child process, writes the same req-<id>.json the
# plugin writes, and checks every answer against the plugin's contract:
#
#   pass    - no objection, nothing shown
#   attach  - earned context, no card
#   hold    - one card; "Add the guardrail" answers attach with the guardrail
#             and "Send as written" answers pass
#   close   - the card goes away when the request disappears
#   guard   - a second daemon on the same folder refuses to start
#   quiet   - no prompt text reaches daemon.log or trace.jsonl
#   wire    - every verdict is BOM-less UTF-8 and parses in Node
#
# Windows only, like the daemon. Exits non-zero if any check fails.

param([switch]$Keep)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

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
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
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
  $payload = @{
    id = $id
    text = $Text
    ctx = @{ turn = 0; attempts = 0; files = @(); errors = @(); tests = @(); constraints = @(); success = @(); goals = @() }
    cwd = 'C:\repo'
    sid = 's-live'
  } | ConvertTo-Json -Depth 8 -Compress
  $path = Join-Path $ipc ('req-' + $id + '.json')
  $tmp = $path + '.tmp'
  [System.IO.File]::WriteAllText($tmp, $payload, $utf8)
  if ($AgeSeconds -gt 0) { (Get-Item -LiteralPath $tmp).LastWriteTime = (Get-Date).AddSeconds(-$AgeSeconds) }
  Move-Item -LiteralPath $tmp -Destination $path -Force
  return $id
}

function Wait-Json([string]$Name, [int]$Milliseconds = 3000) {
  $path = Join-Path $ipc $Name
  $until = (Get-Date).AddMilliseconds($Milliseconds)
  while ((Get-Date) -lt $until) {
    if (Test-Path -LiteralPath $path) {
      try { return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json) } catch { }
    }
    Start-Sleep -Milliseconds 40
  }
  return $null
}

function Test-NodeJson([string]$Path) {
  if (-not $node) { return $false }
  & $node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" $Path 2>$null
  return ($LASTEXITCODE -eq 0)
}

function Test-NoBom([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  return -not ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
}

function Find-Card([int]$Milliseconds = 3000) {
  $until = (Get-Date).AddMilliseconds($Milliseconds)
  while ((Get-Date) -lt $until) {
    $rootEl = [System.Windows.Automation.AutomationElement]::RootElement
    $idCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'CodeCoachGateCard')
    $el = $rootEl.FindFirst([System.Windows.Automation.TreeScope]::Children, $idCond)
    if ($el) { return $el }
    # Fallback for a build that does not surface the window's AutomationId.
    $nameCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Code Coach')
    $wins = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Children, $nameCond)
    foreach ($w in $wins) {
      $btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'CoachAddGuardrail')
      if ($w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $btnCond)) { return $w }
    }
    Start-Sleep -Milliseconds 80
  }
  return $null
}

function Invoke-CardButton($Card, [string]$AutomationId) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $AutomationId)
  $button = $Card.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if (-not $button) { return $false }
  $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $pattern.Invoke()
  return $true
}

function Wait-CardGone([int]$Milliseconds = 3000) {
  $until = (Get-Date).AddMilliseconds($Milliseconds)
  while ((Get-Date) -lt $until) {
    if (-not (Find-Card 60)) { return $true }
    Start-Sleep -Milliseconds 60
  }
  return $false
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

  # pass
  $id = Write-Req 'Summarize the current state of the parser'
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $res = Wait-Json ('res-' + $id + '.json') 1500
  $sw.Stop()
  Check 'pass: verdict inside VERDICT_MS' ($null -ne $res -and $sw.ElapsedMilliseconds -lt 1500) ($sw.ElapsedMilliseconds.ToString() + ' ms')
  Check 'pass: action is pass' ($null -ne $res -and $res.action -eq 'pass') ($res | ConvertTo-Json -Compress)
  Check 'pass: response parses in Node' (Test-NodeJson (Join-Path $ipc ('res-' + $id + '.json')))
  Check 'pass: response has no BOM' (Test-NoBom (Join-Path $ipc ('res-' + $id + '.json')))
  Remove-Item -LiteralPath (Join-Path $ipc ('req-' + $id + '.json')) -Force

  # attach
  $id = Write-Req 'fix the login flow so the second attempt works'
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $res = Wait-Json ('res-' + $id + '.json') 1500
  $sw.Stop()
  Check 'attach: verdict inside VERDICT_MS' ($null -ne $res -and $sw.ElapsedMilliseconds -lt 1500) ($sw.ElapsedMilliseconds.ToString() + ' ms')
  Check 'attach: action is attach' ($null -ne $res -and $res.action -eq 'attach') ($res | ConvertTo-Json -Compress)
  Check 'attach: names the missing target' ($null -ne $res -and [string]$res.attachment -match 'Target: name the file')
  Check 'attach: response parses in Node' (Test-NodeJson (Join-Path $ipc ('res-' + $id + '.json')))
  Remove-Item -LiteralPath (Join-Path $ipc ('req-' + $id + '.json')) -Force

  # hold -> Add the guardrail
  $id = Write-Req 'delete all the logs from last week'
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $res = Wait-Json ('res-' + $id + '.json') 1500
  $sw.Stop()
  Check 'hold: verdict inside VERDICT_MS' ($null -ne $res -and $sw.ElapsedMilliseconds -lt 1500) ($sw.ElapsedMilliseconds.ToString() + ' ms')
  Check 'hold: action is hold' ($null -ne $res -and $res.action -eq 'hold') ($res | ConvertTo-Json -Compress)
  $card = Find-Card 3000
  Check 'hold: card is up' ($null -ne $card)
  $clicked = if ($card) { Invoke-CardButton $card 'CoachAddGuardrail' } else { $false }
  Check 'hold: Add the guardrail clicked' $clicked
  $dec = Wait-Json ('dec-' + $id + '.json') 3000
  Check 'hold: decision is attach' ($null -ne $dec -and $dec.action -eq 'attach') ($dec | ConvertTo-Json -Compress)
  Check 'hold: decision carries the guardrail' ($null -ne $dec -and [string]$dec.attachment -match 'commit the current state')
  Check 'hold: decision parses in Node' (Test-NodeJson (Join-Path $ipc ('dec-' + $id + '.json')))
  Check 'hold: decision has no BOM' (Test-NoBom (Join-Path $ipc ('dec-' + $id + '.json')))
  Check 'hold: card closed after the click' (Wait-CardGone 3000)
  Remove-Item -LiteralPath (Join-Path $ipc ('req-' + $id + '.json')) -Force

  # hold -> Send as written
  $id = Write-Req 'wipe the cache directory completely'
  $res = Wait-Json ('res-' + $id + '.json') 1500
  Check 'hold: second verdict arrives' ($null -ne $res -and $res.action -eq 'hold')
  $card = Find-Card 3000
  Check 'hold: second card is up' ($null -ne $card)
  $clicked = if ($card) { Invoke-CardButton $card 'CoachSendAsWritten' } else { $false }
  Check 'hold: Send as written clicked' $clicked
  $dec = Wait-Json ('dec-' + $id + '.json') 3000
  Check 'hold: Send as written answers pass' ($null -ne $dec -and $dec.action -eq 'pass') ($dec | ConvertTo-Json -Compress)
  Check 'hold: second card closed' (Wait-CardGone 3000)
  Remove-Item -LiteralPath (Join-Path $ipc ('req-' + $id + '.json')) -Force

  # card closes when the request disappears
  $id = Write-Req 'reset the database to a clean state'
  $res = Wait-Json ('res-' + $id + '.json') 1500
  Check 'close: hold verdict arrives' ($null -ne $res -and $res.action -eq 'hold')
  $card = Find-Card 3000
  Check 'close: card is up before the request is removed' ($null -ne $card)
  Remove-Item -LiteralPath (Join-Path $ipc ('req-' + $id + '.json')) -Force
  Check 'close: card goes away with the request' (Wait-CardGone 3000)
  Check 'close: no decision is invented' (-not (Test-Path -LiteralPath (Join-Path $ipc ('dec-' + $id + '.json'))))

  # stale request from a plugin that is no longer waiting
  $id = Write-Req 'delete all the logs from last week' 5
  $path = Join-Path $ipc ('req-' + $id + '.json')
  $res = Wait-Json ('res-' + $id + '.json') 1500
  Check 'stale: abandoned request is answered pass' ($null -ne $res -and $res.action -eq 'pass')
  Check 'stale: no card for an abandoned request' (-not (Find-Card 400))
  Check 'stale: request is removed' (-not (Test-Path -LiteralPath $path))

  # pid guard
  $env:COACH_DATA_DIR = $data
  $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $daemon 2>&1
  $code = $LASTEXITCODE
  $env:COACH_DATA_DIR = $previous
  Check 'guard: second daemon exits 2' ($code -eq 2) ('exit ' + $code)
  Check 'guard: second daemon names the running pid' (($out -join "`n") -match 'refused: daemon \d+ is already running')

  # quiet + wire
  $requests = @(Get-ChildItem -LiteralPath $ipc -Filter 'req-*.json' -File -ErrorAction SilentlyContinue)
  Check 'quiet: no request files left behind' ($requests.Count -eq 0) ($requests.Count.ToString() + ' left')
  $logText = if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Raw } else { '' }
  $traceText = if (Test-Path -LiteralPath $trace) { Get-Content -LiteralPath $trace -Raw } else { '' }
  $secrets = @(
    'Summarize the current state of the parser',
    'fix the login flow so the second attempt works',
    'delete all the logs from last week',
    'wipe the cache directory completely',
    'reset the database to a clean state'
  )
  $leaked = @($secrets | Where-Object { $logText -like ('*' + $_ + '*') -or $traceText -like ('*' + $_ + '*') })
  Check 'quiet: no prompt text in daemon.log or trace.jsonl' ($leaked.Count -eq 0) ($leaked -join ' | ')
  $actions = @()
  foreach ($line in @($traceText -split '\r?\n')) {
    if (-not $line) { continue }
    try { $ev = $line | ConvertFrom-Json; if ($ev.action) { $actions += [string]$ev.action } } catch { }
  }
  Check 'wire: trace records pass, attach, and hold' (($actions -contains 'pass') -and ($actions -contains 'attach') -and ($actions -contains 'hold')) (($actions -join ','))

  # graceful stop
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
