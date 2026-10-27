# Prove-CodeCoach.ps1 - the live proof, against the running daemon and the real
# configured model. Four sends, each with its own receipt:
#
#   A. destructive ask        -> silent context attach, words untouched
#   L. login-endpoint ask     -> facts=0 security lane -> real nudge card ->
#                                Explain why (teaching) -> Fix my prompt (clipboard)
#   C. clean, well-formed ask -> triage runs and stays SILENT (the promise)
#   S. Snooze click           -> quiet hours persisted to state.json
#
# Every claim prints the trace line that proves it. Nothing here edits source or
# restarts the daemon; the daemon must already be on the build under test. The
# script refuses to call a run valid if the daemon predates `state_restored`.
#
#   powershell -NoProfile -STA -ExecutionPolicy Bypass -File tests\Prove-CodeCoach.ps1
#   ... -ShotsDir C:\path\to\shots
#
# Exit 0 only when every receipt passed.

param(
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [string]$DataDir = '',
  [string]$ShotsDir = '',
  [int]$CardTimeoutSec = 480
)

$ErrorActionPreference = 'Stop'
try { Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes } catch { }
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class CoachProofShot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@
# Physical pixels before any rect is read: without this the capture is offset
# by the display scale and clips the card.
[void][CoachProofShot]::SetProcessDPIAware()

. (Join-Path $Repo 'src\Coach.Common.ps1')
. (Join-Path $Repo 'src\Coach.Intent.ps1')
. (Join-Path $Repo 'src\Coach.Code.ps1')
. (Join-Path $Repo 'src\Coach.Analyzer.ps1')

$data = if ($DataDir) { $DataDir } elseif ($env:COACH_DATA_DIR) { $env:COACH_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'CodeCoachData' }
$ipc = Join-Path $data 'ipc'
$trace = Join-Path $data 'trace.jsonl'
$statePath = Join-Path $data 'state.json'
$shots = if ($ShotsDir) { $ShotsDir } else { Join-Path $Repo 'docs\proof' }
New-Item -ItemType Directory -Force -Path $shots | Out-Null

$run = 'p' + (Get-Date -Format 'HHmmss')
$sid = 'sess-proof-' + $run
$proofStartMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$script:Tally = @{ pass = 0; fail = 0; warn = 0 }
$script:Evidence = New-Object System.Collections.ArrayList

function Receipt([string]$Name, [string]$Line, [bool]$Ok, [string]$Kind = 'PASS') {
  if ($Ok) { $script:Tally.pass++; Write-Output ('[PASS] ' + $Name) }
  elseif ($Kind -eq 'WARN') { $script:Tally.warn++; Write-Output ('[WARN] ' + $Name) }
  else { $script:Tally.fail++; Write-Output ('[FAIL] ' + $Name) }
  if ($Line) {
    $n = [Math]::Min(320, $Line.Length)
    Write-Output ('       ' + $Line.Substring(0, $n))
    [void]$script:Evidence.Add(('[' + $(if ($Ok) { 'PASS' } else { 'FAIL' }) + '] ' + $Name + ' :: ' + $Line.Substring(0, $n)))
  }
}
function Info([string]$Name, [string]$Line) {
  Write-Output ('[INFO] ' + $Name)
  if ($Line) { Write-Output ('       ' + $Line.Substring(0, [Math]::Min(320, $Line.Length))) }
}
function Plant([string]$Id, [string]$Text, [hashtable]$Ctx) {
  $req = @{ id = $Id; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); sid = $sid; cid = $Id; cwd = $Repo; text = $Text; ctx = $Ctx }
  Write-JsonAtomic (Join-Path $ipc ('req-' + $Id + '.json')) $req
  Write-Host ('PLANTED ' + $Id + '  len=' + $Text.Length)
  return [int64]$req.ts
}
function Read-IpcJson([string]$Id, [string]$Prefix) {
  for ($i = 0; $i -lt 120; $i++) {
    $j = Read-JsonFile (Join-Path $ipc ($Prefix + '-' + $Id + '.json'))
    if ($j) { return $j }
    Start-Sleep -Milliseconds 250
  }
  return $null
}
function Trace-Lines([int]$Tail) { return @(Get-Content $trace -Tail $Tail -ErrorAction SilentlyContinue) }
function Ts-Of([string]$Line) { if ($Line -match '"ts":(\d{12,18})') { return [int64]$Matches[1] }; return 0 }
function Wait-TraceMatch([string]$Pattern, [int]$TimeoutSec, [long]$SinceMs) {
  $deadline = ([DateTimeOffset]::UtcNow).AddSeconds($TimeoutSec)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    $lines = Trace-Lines 6000
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
      if ($lines[$i] -match '"ts":(\d{12,18})') { if ([int64]$Matches[1] -lt $SinceMs) { break } } else { continue }
      if ($lines[$i] -match $Pattern) { return $lines[$i] }
    }
    Start-Sleep -Milliseconds 700
  }
  return $null
}
function Get-Hwnd([string]$Line) { if ($Line -match '"hwnd":(\d+)') { return [int64]$Matches[1] }; return 0 }
function Save-CardShot([long]$Hwnd, [string]$Name) {
  if ($Hwnd -le 0) { return '' }
  $h = [IntPtr]$Hwnd
  if (-not [CoachProofShot]::IsWindow($h)) { return '' }
  $r = New-Object CoachProofShot+RECT
  [void][CoachProofShot]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
  if ($w -le 0 -or $ht -le 0) { return '' }
  $bmp = New-Object System.Drawing.Bitmap($w, $ht)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc(); $ok = [CoachProofShot]::PrintWindow($h, $hdc, 2); $g.ReleaseHdc($hdc)
  if (-not $ok) { $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size) }
  # A capture excluded by SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) is
  # all black. Shipping that as evidence would be worse than no shot at all,
  # so a blank frame is reported and never written.
  $blank = $true
  for ($x = 0; $x -lt $w -and $blank; $x += [Math]::Max(1, [int]($w / 16))) {
    for ($y = 0; $y -lt $ht; $y += [Math]::Max(1, [int]($ht / 16))) {
      $c = $bmp.GetPixel($x, $y)
      if ($c.R -gt 8 -or $c.G -gt 8 -or $c.B -gt 8) { $blank = $false; break }
    }
  }
  if ($blank) { $g.Dispose(); $bmp.Dispose(); return 'blank' }
  $out = Join-Path $shots $Name
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  return $out
}
function Shot([long]$Hwnd, [string]$Name, [string]$Label) {
  $p = Save-CardShot $Hwnd $Name
  if ($p -eq 'blank') {
    Write-Output ('[SHOT-MISS] ' + $Label + ': capture was blank (cardExcludeFromCapture?)')
    return ''
  }
  if ($p) { Write-Output ('[SHOT] ' + $Label + ' -> ' + $p); return $p }
  Write-Output ('[SHOT-MISS] ' + $Label + ': no live window at hwnd ' + $Hwnd)
  return ''
}
function Invoke-CardButton([long]$Hwnd, [string]$Name) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Hwnd)
  if (-not $root) { throw ('no window at hwnd ' + $Hwnd) }
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Name)
  $btn = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if (-not $btn) { throw ("button '" + $Name + "' not found") }
  ($btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
}
function Get-UiaTexts([long]$Hwnd) {
  $out = New-Object System.Collections.ArrayList
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Hwnd)
    if (-not $root) { return @() }
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($e in $all) { try { $n = [string]$e.Current.Name; if ($n.Trim()) { [void]$out.Add($n.Trim()) } } catch { } }
  } catch { }
  return @($out)
}
function Get-ClipText {
  for ($i = 0; $i -lt 20; $i++) {
    try { $t = [System.Windows.Clipboard]::GetText(); if ($t) { return [string]$t } } catch { }
    Start-Sleep -Milliseconds 150
  }
  return ''
}
function Latest-TriageStart([long]$SinceMs) {
  $lines = Trace-Lines 3000
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    if ($lines[$i] -match '"ev":"triage_(lane|started)"') { $t = Ts-Of $lines[$i]; if ($t -ge $SinceMs) { return $t } }
  }
  return 0
}
function Wait-SpacingOpen([long]$LastStartTs, [double]$Spacing) {
  if ($LastStartTs -le 0) { return }
  $target = $LastStartTs + [long]($Spacing * 1000) + 12000
  $left = ($target - ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())) / 1000.0
  if ($left -le 0) { return }
  Write-Output ('waiting ' + [int]$left + 's for the triage spacing window...')
  while (([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) -lt $target) { Start-Sleep -Seconds 5 }
}
function New-CleanDraft([string]$Rel) {
  return ('refactor {0}: pull the timestamp normalization out of the Append-CoachTrace body into a small private helper, keep behavior identical, add one focused test under tests/, and do not rename any public function' -f $Rel)
}
function Pick-CleanFile {
  $cache = Read-JsonFile (Join-Path $data 'analyzer-cache.json')
  if (-not $cache -or -not $cache.files) { return $null }
  $cands = @()
  foreach ($p in @($cache.files.PSObject.Properties)) {
    $rel = [string]$p.Value.path
    $at = [long]$p.Value.at
    $full = Join-Path $Repo ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $full)) { continue }
    if ($rel -notmatch '\.ps1$' -or $rel -match '^docs/') { continue }
    # Freshness is a content hash in Get-CachedFileBrief, not an mtime; the
    # facts call below is the only honest test of whether this brief still
    # grounds a claim.
    $cands += [pscustomobject]@{ rel = $rel; at = $at }
  }
  foreach ($cand in @($cands | Sort-Object at -Descending)) {
    $draft = New-CleanDraft $cand.rel
    $facts = @(Get-AnalyzerFactsForDraft -Draft $draft -Ctx @{ Files = @($cand.rel); Repo = @{ root = $Repo } } -Max 2)
    if ($facts.Count -gt 0) { return [pscustomobject]@{ rel = $cand.rel; draft = $draft; facts = $facts.Count } }
  }
  return $null
}

$cfg = Read-JsonFile (Join-Path $data 'config.json')
if (-not $cfg) { Write-Output ('no config at ' + $data); exit 2 }
$spacing = [double]$cfg.triageScanSeconds
if ($spacing -le 0) { $spacing = 30.0 }
$model = if ($cfg.triageModelName) { [string]$cfg.triageModelName } else { [string]$cfg.triageModel }
$dpid = 0
try { $dpid = [int]((Get-Content (Join-Path $data 'daemon.pid') -Raw).Trim()) } catch { }
$alive = [bool](Get-Process -Id $dpid -ErrorAction SilentlyContinue)

Write-Output '================ Code Coach live proof ================'
Write-Output ('repo:   ' + $Repo)
Write-Output ('data:   ' + $data)
Write-Output ('lane:   ' + $(if ($cfg.triageApiBase) { 'http ' + $cfg.triageApiBase } else { 'cli' }) + '  model=' + $model)
Write-Output ('daemon: pid ' + $dpid + ' alive=' + $alive)
Write-Output ('run:    ' + $run)
Write-Output ''

if (-not $alive) {
  Write-Output 'The daemon is not running. Start it first: powershell -File src\Coach.Daemon.ps1 -Force'
  exit 2
}

# The build under test is the one that writes state_restored at boot. Without
# it, this proof would be measuring yesterday's binary.
$ready = Wait-TraceMatch '"ev":"daemon_ready"' 5 ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 86400000)
$restored = Wait-TraceMatch '"ev":"state_restored"' 5 ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 86400000)
Receipt 'the daemon under test is the build with persisted state' $restored ($null -ne $restored)
if (-not $restored) {
  Write-Output 'Restart the daemon on the current source before trusting this run.'
  exit 1
}

foreach ($pat in @('req-proof*', 'res-proof*', 'dec-proof*', 'req-login*', 'res-login*', 'dec-login*')) {
  Get-ChildItem -LiteralPath $ipc -Filter $pat -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}
$bootDrain = Wait-TraceMatch '"ev":"analyzer_(ok|skip)"' 8 ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 3600000)
Info 'boot analyzer pass (pipe free or already free)' ($(if ($bootDrain) { $bootDrain } else { 'no recent pass; proceeding' }))
Wait-SpacingOpen (Latest-TriageStart ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - 7200000)) $spacing

# ---------------- A: the destructive ask -> silent attach -------------------
Write-Output ''
Write-Output '--- A: destructive ask -> silent context attach, words untouched ---'
$idA = ''; $draftA = 'delete the entire data folder including the old sqlite files, then reset the database schema from scratch, do it right now'
$tA = 0; $resA = $null
for ($attemptA = 1; $attemptA -le 3; $attemptA++) {
  if ($attemptA -gt 1) { Start-Sleep -Seconds 20 }
  $idA = 'proofa' + $attemptA + '-' + $run
  $tA = Plant $idA $draftA @{}
  $resA = Read-IpcJson $idA 'res'
  if ($resA) { break }
  Info ('A attempt ' + $attemptA + ': no verdict; a card may be holding the gate') ''
}
if ($resA) {
  $attLen = ([string]$resA.attachment).Length
  Receipt 'A verdict is attach with a context body' ('action=' + $resA.action + ' attachment_len=' + $attLen) ([string]$resA.action -eq 'attach' -and $attLen -gt 0)
  $attached = [string]$resA.attachment
  $echoed = ($attached -match 'reset the database') -or ($attached -match 'delete the entire data folder')
  Receipt 'A the attached context does not echo the draft' ('attachment_len=' + $attached.Length + ' echo=' + $echoed) (-not $echoed)
} else {
  Receipt 'A verdict came back on res-' '' $false
}
$cardA = Wait-TraceMatch '"ev":"card_shown"[^}]*"kind":"nudge"' 2 $tA
Receipt 'A no nudge card: a send with nothing to triage stays silent' ('nudge=' + [bool]$cardA) ($null -eq $cardA)
# A is attach, so triage also watches it. Drain that pass before the next send:
# a nudge sitting on screen would hold the gate and starve the rows below.
$aEnd = Wait-TraceMatch '"ev":"(triage_card|triage_silent|triage_ungrounded|triage_skip|triage_parsefail)"' 150 $tA
if ($aEnd -match '"ev":"triage_card"') {
  $aShown = Wait-TraceMatch '"ev":"card_shown"[^}]*"kind":"nudge"' 15 $tA
  $aHwnd = Get-Hwnd $aShown
  if ($aHwnd -gt 0) { try { Invoke-CardButton $aHwnd 'Ignore' } catch { } }
  Info 'A the attach also triaged; its card was dismissed' $aShown
}

# ---------------- L0: the no-file security ask -> the lane opens ------------
Write-Output ''
Write-Output '--- L0: login ask naming NO file -> security lane reaches the model ---'
$secDraft = "Add a login endpoint that checks the user's password against the database"
$secCtx = @{ turn = 0; attempts = 0; Files = @(); errors = @(); tests = @(); constraints = @(); success = @(); goals = @() }
$secId = 'proof-sec-' + $run
Wait-SpacingOpen (Latest-TriageStart 0) $spacing
$secTs = Plant $secId $secDraft $secCtx
$secRes = Read-IpcJson $secId 'res'
$secEv = Wait-TraceMatch '"ev":"triage_security"' 30 $secTs
$secStart = Wait-TraceMatch '"ev":"triage_started"' 150 $secTs
if ($secRes) {
  Receipt 'L0 the no-file security send passes the gate' ('action=' + $secRes.action + ' reason=' + $secRes.reason) ([string]$secRes.action -eq 'pass')
} else {
  Receipt 'L0 verdict came back on res-sec' '' $false
}
Receipt 'L0 facts=0 marks the security lane instead of dying on no-facts' $secEv ($null -ne $secEv -and $secEv -match '"facts":0')
Receipt 'L0 the security send starts a real triage pass' $secStart ($null -ne $secStart)
# The model may or may not card a no-file draft; either outcome is honest. Wait
# for it so a card cannot sit on screen and block the grounded send below.
$secEnd = Wait-TraceMatch '"ev":"(triage_card|triage_silent|triage_ungrounded|triage_skip|triage_parsefail)"' 150 $secTs
if ($secEnd -match '"ev":"triage_card"') {
  $secShown = Wait-TraceMatch '"ev":"card_shown"[^}]*"kind":"nudge"' 15 $secTs
  $secHwnd = Get-Hwnd $secShown
  if ($secHwnd -gt 0) {
    [void](Shot $secHwnd 'security-nudge-no-file.png' 'no-file security nudge (real model, if it carded)')
    try { Invoke-CardButton $secHwnd 'Ignore' } catch { }
  }
  Info 'L0 the no-file draft produced a card; captured and dismissed it' $secShown
} else {
  Info 'L0 the no-file draft ended without a card (honest model outcome)' $secEnd
}

# ---------------- L: the grounded login ask -> nudge card -------------------
Write-Output ''
Write-Output '--- L: login ask naming a real file -> grounded nudge -> Explain/Fix ---'
$loginDraft = "Add a login endpoint in src/Coach.Gate.ps1 that checks the user's password against the database"
$loginCtx = @{ turn = 0; attempts = 0; Files = @('src/Coach.Gate.ps1'); errors = @(); tests = @(); constraints = @(); success = @(); goals = @(); Repo = @{ root = $Repo } }
$loginRes = $null; $loginStart = $null; $loginEnd = $null; $loginId = ''; $loginTs = 0
for ($attempt = 1; $attempt -le 3; $attempt++) {
  $loginId = if ($attempt -eq 1) { 'proof-login-' + $run } else { 'proof-login' + $attempt + '-' + $run }
  Wait-SpacingOpen (Latest-TriageStart 0) $spacing
  $loginTs = Plant $loginId $loginDraft $loginCtx
  $loginRes = Read-IpcJson $loginId 'res'
  $evL = Wait-TraceMatch '"ev":"(triage_started|triage_skip|triage_parsefail)"' 150 $loginTs
  if ($evL -match '"ev":"triage_started"') {
    $loginStart = $evL
    # An ungrounded answer is a real outcome, not a hang: the model named a file
    # the draft never mentioned. Retry instead of waiting out the card timeout.
    $loginEnd = Wait-TraceMatch '"ev":"(triage_card|triage_silent|triage_skip|triage_parsefail|triage_ungrounded)"' $CardTimeoutSec $loginTs
    if ($loginEnd -match '"ev":"triage_card"') { break }
    Info ('L attempt ' + $attempt + ': triage ended without a card') $loginEnd
  } else {
    Info ('L attempt ' + $attempt + ': no triage start') $evL
  }
}
if ($loginRes) {
  Receipt 'L the grounded login send passes the gate' ('action=' + $loginRes.action + ' reason=' + $loginRes.reason) ([string]$loginRes.action -eq 'pass')
} else {
  Receipt 'L verdict came back on res-login' '' $false
}
Receipt 'L the grounded login send starts a real triage pass' $loginStart ($null -ne $loginStart)
Receipt 'L the model returns a nudge decision' $loginEnd ($null -ne $loginEnd -and $loginEnd -match '"ev":"triage_card"')
$lnL = Wait-TraceMatch '"ev":"card_shown"[^}]*"kind":"nudge"' 20 $loginTs
$hwndL = Get-Hwnd $lnL
Receipt ('L the nudge card showed (hwnd ' + $hwndL + ')') $lnL ($null -ne $lnL -and $hwndL -gt 0)
if ($hwndL -gt 0) {
  [void](Shot $hwndL 'security-nudge.png' 'security nudge card (real model)')
  $textsL = @(Get-UiaTexts $hwndL)
  $joinedL = ($textsL -join ' | ')
  $hasRateL = [bool]($joinedL -match '(?i)(rate[- ]?limit|throttl|brute[- ]?force|attempts? per)')
  Receipt 'L the nudge names rate limiting' ('texts=' + $joinedL) $hasRateL 'WARN'
  $footL = @($textsL | Where-Object { $_ -match 'draft sent to|prompt-grounded|nothing leaves' })
  Receipt 'L the footer names the model that judged the draft' ($footL -join ' | ') (($footL -join ' ') -match ('draft sent to ' + [regex]::Escape($model)))
  Receipt 'L the footer never claims nothing leaves the machine' ($footL -join ' | ') (-not ($textsL -contains 'nothing leaves this machine'))

  try {
    $clickAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Invoke-CardButton $hwndL 'Explain why'
    $lnWhy = Wait-TraceMatch '"ev":"card_shown"[^}]*"kind":"nudge"' 25 $clickAt
    $hwndWhy = Get-Hwnd $lnWhy
    $textsWhy = @()
    if ($hwndWhy -gt 0) { $textsWhy = @(Get-UiaTexts $hwndWhy) }
    $joinedWhy = ($textsWhy -join ' | ')
    $teachL = [bool](($joinedWhy -match '(?i)\bWHY\b') -and ($joinedWhy -match '(?i)(first principle|bcrypt|argon2|constant[- ]time|token[- ]bucket|rate[- ]?limit|brute)'))
    Receipt 'L Explain why rebuilds the card with the teaching' ('texts=' + $joinedWhy) ($null -ne $lnWhy -and $teachL)
    $hasHashAll = [bool](($joinedL + ' ' + $joinedWhy) -match '(?i)\b(argon2id|argon2|bcrypt|scrypt|salt|hash(?:ed|ing)?)\b')
    Receipt 'L the card names password hashing (nudge or teaching)' ('nudge+why_len=' + ($joinedL.Length + $joinedWhy.Length)) $hasHashAll
    if ($hwndWhy -gt 0) { [void](Shot $hwndWhy 'security-explain.png' 'security Explain why card') }
    try { [System.Windows.Clipboard]::Clear() } catch { }
    Invoke-CardButton $hwndWhy 'Fix my prompt'
    $fixedL = Get-ClipText
    $fixedOk = [bool](($fixedL -match '(?i)(argon2|bcrypt|scrypt|hash|constant[- ]time)') -and ($fixedL -match '(?i)(rate[- ]?limit|throttl|token[- ]bucket|attempt)'))
    Receipt 'L Fix my prompt puts a complete rewrite on the clipboard' ('clipboard_len=' + $fixedL.Length) $fixedOk
  } catch {
    Receipt ('L card clicks failed: ' + $_.Exception.Message) '' $false
  }
  $idleL = Wait-TraceMatch '"ev":"triage_idle"' 20 $loginTs
  Receipt 'L the lane reports itself idle after the card' $idleL ($null -ne $idleL -and $idleL -match '"outcome":"card"')
}

# ---------------- C: a clean ask -> silence --------------------------------
Write-Output ''
Write-Output '--- C: clean ask naming a briefed file -> triage runs, stays silent ---'
$clean = Pick-CleanFile
if (-not $clean) {
  Receipt 'C a briefed, unchanged file exists for the clean send' '' $false
} else {
  Info 'C clean draft targets' ($clean.rel + ' (facts=' + $clean.facts + ')')
  $resC = $null; $startC = $null; $endC = $null; $silentC = $false
  for ($attemptC = 1; $attemptC -le 3; $attemptC++) {
    Wait-SpacingOpen (Latest-TriageStart 0) $spacing
    $idC = 'proofc' + $attemptC + '-' + $run
    $tC = Plant $idC $clean.draft @{ Files = @($clean.rel); Repo = @{ root = $Repo } }
    $resC = Read-IpcJson $idC 'res'
    if (-not ($resC -and [string]$resC.action -eq 'pass')) { break }
    $startC = Wait-TraceMatch '"ev":"triage_started"' 60 $tC
    $endC = Wait-TraceMatch '"ev":"(triage_silent|triage_card|triage_skip|triage_parsefail)"' $CardTimeoutSec $tC
    if ($endC -match '"ev":"triage_silent"') { $silentC = $true; break }
    if ($endC -match '"ev":"triage_card"') { break }
    if ($endC -match 'rate-limited|network|timeout|no-key') {
      Info ('C attempt ' + $attemptC + ': provider did not answer') $endC
      continue
    }
    break
  }
  Receipt 'C the clean send passes the gate' ('action=' + $(if ($resC) { $resC.action } else { '?' })) ($resC -and [string]$resC.action -eq 'pass')
  Receipt 'C the lane actually examines the clean send' $startC ($null -ne $startC)
  Receipt 'C the model had nothing worth interrupting for: no card' $endC $silentC
  $cardC = Wait-TraceMatch '"ev":"card_shown"[^}]*"kind":"nudge"' 2 $tC
  Receipt 'C no nudge card appeared' ('nudge=' + [bool]$cardC) ($null -eq $cardC)
}

# ---------------- S: Snooze persists --------------------------------------
Write-Output ''
Write-Output '--- S: Snooze buys quiet hours and the click is persisted ---'
if ($hwndL -gt 0) {
  try {
    # The L card is gone after Fix my prompt; plant one more security send and
    # snooze that card instead of guessing at a closed window. Two attempts
    # because a model that stayed silent once may still card the next send.
    $snoozed = $null
    # A named real file keeps the nudge grounded: the login draft with no file
    # is a coin flip, because the model sometimes invents a path and the
    # grounding gate correctly drops the card. S is about the click path, not
    # about teaching the model to behave.
    $snoozeDraft = "Add a login endpoint in src/Coach.Gate.ps1 that checks the user's password against the database"
    $snoozeCtx = @{ turn = 0; attempts = 0; Files = @('src/Coach.Gate.ps1'); errors = @(); tests = @(); constraints = @(); success = @(); goals = @(); Repo = @{ root = $Repo } }
    for ($attemptS = 1; $attemptS -le 3 -and -not $snoozed; $attemptS++) {
      Wait-SpacingOpen (Latest-TriageStart 0) $spacing
      $idS = 'proofs' + $attemptS + '-' + $run
      $tS = Plant $idS $snoozeDraft $snoozeCtx
      $null = Read-IpcJson $idS 'res'
      $startS = Wait-TraceMatch '"ev":"triage_started"' 60 $tS
      $cardS = Wait-TraceMatch '"ev":"(triage_card|triage_ungrounded|triage_silent)"' $CardTimeoutSec $tS
      $shownS = Wait-TraceMatch '"ev":"card_shown"[^}]*"kind":"nudge"' 20 $tS
      $hwndS = Get-Hwnd $shownS
      if ($startS -and ($cardS -match '"ev":"triage_card"') -and $hwndS -gt 0) {
        Invoke-CardButton $hwndS 'Snooze'
        $snoozed = Wait-TraceMatch '"ev":"card_snoozed"' 20 $tS
        Receipt 'S Snooze closes the card and records quiet minutes' $snoozed ($null -ne $snoozed)
      } else {
        Info ('S attempt ' + $attemptS + ': no card to snooze') ('start=' + [bool]$startS + ' card=' + [bool]$cardS + ' hwnd=' + $hwndS)
      }
    }
    if ($snoozed) {
      $state = Read-JsonFile $statePath
      $until = $null
      if ($state -and $state.snoozeUntil) {
        try { $until = [datetime]::Parse([string]$state.snoozeUntil, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime() } catch { }
      }
      Receipt 'S the Snooze deadline survives in state.json' ([string]$state.snoozeUntil) ($until -and $until -gt [datetime]::UtcNow)
    } else {
      Receipt 'S a second nudge card was available to snooze' '' $false
    }
  } catch {
    Receipt ('S snooze failed: ' + $_.Exception.Message) '' $false
  }
} else {
  Info 'S skipped: the L row did not produce a card' ''
}

Write-Output ''
Write-Output '--- trace since this run ---'
$dump = @(Trace-Lines 8000) | Where-Object { $_ -match '"ev":"(triage_security|triage_started|triage_card|triage_silent|triage_skip|triage_idle|triage_ungrounded|card_shown|card_snoozed|state_restored)"' -and (Ts-Of $_) -ge $proofStartMs }
foreach ($s in $dump) { Write-Output ('       ' + $s) }

Write-Output ''
Write-Output ('================ proof complete: ' + $script:Tally.pass + ' pass, ' + $script:Tally.warn + ' warn, ' + $script:Tally.fail + ' fail ================')
if ($script:Tally.fail -gt 0) { exit 1 }
exit 0
