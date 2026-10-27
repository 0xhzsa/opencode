# Coach.Trace.ps1 - append-only trace with a hard rule: draft text never lands on disk.
# Every write goes through Write-TraceEvent, which drops any field whose name looks
# like content. That guard is tested, not trusted.

$script:TraceSession  = $null
$script:TraceMono0    = $null
$script:TraceMaxBytes = 8MB
$script:TraceForbidden = @('text', 'draft', 'drafttext', 'rewrite', 'prompt', 'content',
                           'hunk', 'secret', 'diff', 'body', 'message', 'line')

function Initialize-Trace {
  $script:TraceSession = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $script:TraceMono0 = [Diagnostics.Stopwatch]::StartNew()
  $dir = Split-Path -Parent $script:TracePath
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  return $script:TraceSession
}

function Get-DraftHash([string]$Text) {
  if ([string]::IsNullOrEmpty($Text)) { return $null }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $h = $sha.ComputeHash($bytes)
    return (($h[0..5] | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally { $sha.Dispose() }
}

function Test-TraceFieldAllowed([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
  return ($script:TraceForbidden -notcontains $Name.ToLowerInvariant())
}

# A reader (tests, the insights pass, the scoreboard) can be holding trace.jsonl
# when the daemon appends. AppendAllText asks for an exclusive write, so that
# reader wins, the event is lost, and a card_expired that vanished looks like a
# card that never expired. Open with FileShare.ReadWrite and retry a locked file
# instead of dropping the event.
function Add-TraceLine([string]$Path, [string]$Line) {
  $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($Line + "`n")
  $try = 0
  while ($true) {
    try {
      $fs = New-Object IO.FileStream($Path, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
      try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
      return $true
    } catch {
      $try++
      if ($try -ge 8) { throw }
      Start-Sleep -Milliseconds (10 * $try)
    }
  }
}

function Write-TraceEvent {
  param(
    [Parameter(Mandatory = $true)][string]$Code,
    [hashtable]$Fields
  )
  if (-not $script:TraceSession) { Initialize-Trace | Out-Null }
  try {
    $rec = [ordered]@{
      ts   = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      mono = [int]$script:TraceMono0.ElapsedMilliseconds
      sid  = $script:TraceSession
      ev   = $Code
    }
    $dropped = 0
    if ($Fields) {
      foreach ($k in $Fields.Keys) {
        if (-not (Test-TraceFieldAllowed $k)) { $dropped++; continue }
        $rec[$k] = $Fields[$k]
      }
    }
    if ($dropped -gt 0) { $rec['dropped'] = $dropped }
    $line = ($rec | ConvertTo-Json -Compress -Depth 4)
    if ((Test-Path -LiteralPath $script:TracePath) -and
        (Get-Item -LiteralPath $script:TracePath).Length -gt $script:TraceMaxBytes) {
      Move-Item -LiteralPath $script:TracePath -Destination ($script:TracePath -replace '\.jsonl$', '.1.jsonl') -Force
    }
    [void](Add-TraceLine $script:TracePath $line)
  } catch {
    Write-CoachLog ('trace: write failed - ' + $_.Exception.Message)
  }
}
function Write-EventRecord {
  param([Parameter(Mandatory = $true)][string]$Kind, [hashtable]$Fields)
  if (-not $script:TraceSession) { Initialize-Trace | Out-Null }
  $rec = [ordered]@{ ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); kind = $Kind }
  if ($Fields) { foreach ($k in $Fields.Keys) { if (Test-TraceFieldAllowed $k) { $rec[$k] = $Fields[$k] } } }
  try {
    $dir = Split-Path -Parent $script:EventsPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [void](Add-TraceLine $script:EventsPath (($rec | ConvertTo-Json -Compress -Depth 4)))
  } catch { Write-CoachLog ('events: write failed - ' + $_.Exception.Message) }
}

function Read-TraceFile([string]$Path = $script:TracePath) {
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  $out = New-Object System.Collections.ArrayList
  # Share both ways: the daemon appends while a test or the insights pass reads,
  # and a reader that locks writers out makes the coach lose events.
  $fs = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    $reader = New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)
    try {
      while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { [void]$out.Add(($line | ConvertFrom-Json)) } catch { }
      }
    } finally { $reader.Dispose() }
  } finally { $fs.Dispose() }
  return $out
}
