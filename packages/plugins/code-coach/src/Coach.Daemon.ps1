# Coach.Daemon.ps1 - slice 1 of the code-coach gate.
#
# Reads req-<id>.json from the IPC folder, answers res-<id>.json with
# pass | attach | hold, and on hold shows one card with two buttons. The
# plugin waits at most five seconds for a decision; if nobody clicks, the
# prompt is sent as written. Nothing here reads or writes the prompt itself.
#
# Two deterministic rules:
#   destructive ask with no recovery point -> hold, offer the guardrail
#   change ask that names no file           -> attach, name the target
#   anything else                           -> pass
#
# The plugin's own regexes decide whether a send is substantive enough to ask
# about; the verdicts below are this file's alone.
#
# One card at a time. A second hold while a card is up is answered pass rather
# than stacked; queuing is slice 2.

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

if (-not ('CoachGateWin32' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CoachGateWin32 {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int nValue);
}
'@
}

$Data = if ($env:COACH_DATA_DIR) { $env:COACH_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'CodeCoachData' }
$Ipc = Join-Path $Data 'ipc'
$LogDir = Join-Path $Data 'logs'
$Log = Join-Path $LogDir 'daemon.log'
$Trace = Join-Path $Data 'trace.jsonl'
$PidFile = Join-Path $Data 'daemon.pid'
$StopFile = Join-Path $Data 'stop'

New-Item -ItemType Directory -Force -Path $Ipc, $LogDir | Out-Null

# Windows PowerShell 5.1's `Set-Content -Encoding UTF8` writes a BOM, and the
# plugin parses these files with JSON.parse, which rejects one. Write UTF-8
# without a BOM so the Node side can read every verdict.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Log([string]$Line) {
  try { Add-Content -LiteralPath $Log -Value ((Get-Date).ToUniversalTime().ToString('o') + ' ' + $Line) -Encoding UTF8 } catch { }
}

function Write-Trace($Event) {
  try {
    $Event.ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Add-Content -LiteralPath $Trace -Value ($Event | ConvertTo-Json -Compress -Depth 6) -Encoding UTF8
  } catch { }
}

function Write-Json([string]$Path, $Payload) {
  $tmp = $Path + '.tmp'
  [System.IO.File]::WriteAllText($tmp, ($Payload | ConvertTo-Json -Compress -Depth 6), $Utf8NoBom)
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

# A second daemon on the same folder would double-answer every request.
if (Test-Path -LiteralPath $PidFile) {
  $other = 0
  try { $other = [int](Get-Content -LiteralPath $PidFile -Raw) } catch { $other = 0 }
  if ($other -gt 0 -and $other -ne $PID -and (Get-Process -Id $other -ErrorAction SilentlyContinue)) {
    Write-Output ("refused: daemon $other is already running on $Data")
    exit 2
  }
}
[System.IO.File]::WriteAllText($PidFile, [string]$PID, $Utf8NoBom)
Write-Log 'daemon: starting'

$script:ReGuard = '(?i)\b(backup|backed up|commit first|commit before|commit the current|dry[- ]?run|snapshot|confirm|only|specific|this file|one file)\b'
$script:ReHard = '(?i)\b(rm\s+-rf|git\s+clean|force[- ]?push|drop\s+table|truncate\s+table)\b'
$script:ReVerb = '(?i)\b(delete|deletes|deleting|reset|resets|resetting|drop|drops|dropping|truncate|truncates|truncating|overwrite|overwrites|overwriting|wipe|wipes|wiping|purge|purges|purging|destroy|destroys|destroying|remove|removes|removing|clear|clears|clearing)\b'
$script:ReObject = '(?i)\b(files?|folders?|directories?|dirs?|data|database|db|tables?|rows?|records?|logs?|history|branch(es)?|commits?|repo(sitory)?|worktree|build|output|cache|config|credentials?|secrets?|disk|drive|migrations?)\b'
$script:ReChange = '(?i)\b(fix|fixes|fixing|make|makes|making|improve|improves|improving|refactor\w*|rewrite|update|updates|updating|change|changes|changing|handle|handles|handling|support|add|adds|adding|move|moves|rename|remove|removes|removing)\b'
$script:ReFile = '(?i)\b[\w./\\-]+\.(ps1|psm1|psd1|js|mjs|cjs|ts|tsx|jsx|py|cs|go|rs|rb|java|kt|swift|json|ya?ml|toml|md|css|html|sql|sh|bash|bat|cmd|c|h|cpp|hpp)\b'

function Get-Decision([string]$Text) {
  $t = [string]$Text
  if (-not $t) { return @{ action = 'pass' } }
  if ($t -match $script:ReGuard) { return @{ action = 'pass' } }
  if (($t -match $script:ReHard) -or (($t -match $script:ReVerb) -and ($t -match $script:ReObject))) {
    return @{
      action = 'hold'
      title = 'Destructive ask without a recovery point'
      body = 'This deletes or rewrites state, and nothing in the ask makes it reversible. Add the commit, backup, or dry run first.'
      guardrail = 'Before you delete or rewrite anything, commit the current state, take a backup, and run the change against one target first; confirm the result before widening it.'
    }
  }
  if (($t -match $script:ReChange) -and -not ($t -match $script:ReFile)) {
    return @{
      action = 'attach'
      attachment = 'Target: name the file, route, or function this change touches, and the check that proves it works.'
    }
  }
  return @{ action = 'pass' }
}

$script:ActiveCard = $null
$script:CardGuardrail = ''
$script:PumpFrame = $null
$script:Seen = @{}

function Close-Card {
  $card = $script:ActiveCard
  if (-not $card) { return }
  $script:ActiveCard = $null
  try { $card.window.Close() } catch { }
}

function Complete-Card([string]$Action) {
  $card = $script:ActiveCard
  if (-not $card) { return }
  try {
    $payload = @{ action = $Action }
    if ($Action -eq 'attach') { $payload.attachment = $script:CardGuardrail }
    Write-Json (Join-Path $Ipc ('dec-' + $card.id + '.json')) $payload
    Write-Trace @{ ev = 'card_decision'; action = $Action }
  } catch {
    Write-Log ('card decision failed: ' + $_.Exception.Message)
  }
  Close-Card
}

function Invoke-Pump([int]$Milliseconds = 40) {
  $script:PumpFrame = New-Object System.Windows.Threading.DispatcherFrame
  $timer = New-Object System.Windows.Threading.DispatcherTimer
  $timer.Interval = [TimeSpan]::FromMilliseconds($Milliseconds)
  $timer.add_Tick({ $script:PumpFrame.Continue = $false })
  $timer.Start()
  try { [System.Windows.Threading.Dispatcher]::PushFrame($script:PumpFrame) } finally { $timer.Stop() }
}

function Show-Card([string]$Id, $Decision) {
  $script:CardGuardrail = [string]$Decision.guardrail

  $win = New-Object System.Windows.Window
  $win.Title = 'Code Coach'
  $win.WindowStyle = 'None'
  $win.AllowsTransparency = $true
  $win.Background = [System.Windows.Media.Brushes]::Transparent
  $win.ShowInTaskbar = $false
  $win.Topmost = $true
  $win.ShowActivated = $false
  $win.ResizeMode = 'NoResize'
  $win.Focusable = $false
  $win.WindowStartupLocation = 'Manual'
  $win.SizeToContent = 'WidthAndHeight'
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($win, 'CodeCoachGateCard')

  $panel = New-Object System.Windows.Controls.StackPanel
  $panel.Margin = '18,14,18,14'
  $panel.MaxWidth = 420

  $title = New-Object System.Windows.Controls.TextBlock
  $title.Text = [string]$Decision.title
  $title.FontSize = 15
  $title.FontWeight = 'SemiBold'
  $title.TextWrapping = 'Wrap'
  [void]$panel.Children.Add($title)

  $body = New-Object System.Windows.Controls.TextBlock
  $body.Text = [string]$Decision.body
  $body.FontSize = 12
  $body.Margin = '0,6,0,0'
  $body.TextWrapping = 'Wrap'
  [void]$panel.Children.Add($body)

  $row = New-Object System.Windows.Controls.StackPanel
  $row.Orientation = 'Horizontal'
  $row.Margin = '0,12,0,0'

  $add = New-Object System.Windows.Controls.Button
  $add.Content = 'Add the guardrail'
  $add.Padding = '10,4'
  $add.Add_Click({ Complete-Card 'attach' })
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($add, 'CoachAddGuardrail')
  [void]$row.Children.Add($add)

  $keep = New-Object System.Windows.Controls.Button
  $keep.Content = 'Send as written'
  $keep.Padding = '10,4'
  $keep.Margin = '8,0,0,0'
  $keep.Add_Click({ Complete-Card 'pass' })
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($keep, 'CoachSendAsWritten')
  [void]$row.Children.Add($keep)

  [void]$panel.Children.Add($row)

  $border = New-Object System.Windows.Controls.Border
  $border.CornerRadius = '10'
  $border.Padding = '1'
  $border.Background = [System.Windows.Media.Brushes]::White
  $border.BorderBrush = [System.Windows.Media.Brushes]::Silver
  $border.BorderThickness = '1'
  $border.Child = $panel
  $win.Content = $border

  $helper = New-Object System.Windows.Interop.WindowInteropHelper($win)
  [void]$helper.EnsureHandle()
  $ex = [CoachGateWin32]::GetWindowLong($helper.Handle, -20)
  [void][CoachGateWin32]::SetWindowLong($helper.Handle, -20, ($ex -bor 0x08000000 -bor 0x00000080))

  $win.Show()
  $win.UpdateLayout()
  $area = [System.Windows.SystemParameters]::WorkArea
  $win.Left = [Math]::Max($area.Left, $area.Right - $win.ActualWidth - 24)
  $win.Top = [Math]::Max($area.Top, $area.Bottom - $win.ActualHeight - 24)

  # The plugin's DECISION_MS is 5000. The card must be gone before that poll
  # gives up, or a click lands on a card nobody is waiting for any more.
  $script:ActiveCard = @{ id = $Id; window = $win; deadline = (Get-Date).AddMilliseconds(4500) }
  Write-Log ('card up: ' + $Decision.title)
  Write-Trace @{ ev = 'card_shown'; id = $Id }
}

try {
  while ($true) {
    if (Test-Path -LiteralPath $StopFile) { break }

    $requests = @(Get-ChildItem -LiteralPath $Ipc -Filter 'req-*.json' -File -ErrorAction SilentlyContinue)
    foreach ($file in $requests) {
      if ($script:Seen.ContainsKey($file.Name)) { continue }
      $script:Seen[$file.Name] = $true
      try {
        $req = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction Stop | ConvertFrom-Json
        $id = [string]$req.id
        if (-not $id) { continue }

        # A request the plugin has already abandoned must not raise a card.
        # The plugin waits 1500 ms for the verdict, so anything older than
        # 1200 ms has no reader left. Answer pass and remove it.
        $age = ((Get-Date) - $file.LastWriteTime).TotalMilliseconds
        if ($age -gt 1200) {
          Write-Json (Join-Path $Ipc ('res-' + $id + '.json')) @{ action = 'pass' }
          Write-Trace @{ ev = 'gate_stale'; len = ([string]$req.text).Length }
          Remove-Item -LiteralPath $file.FullName -Force
          continue
        }

        $decision = Get-Decision ([string]$req.text)
        if ($decision.action -eq 'hold' -and $script:ActiveCard) {
          $decision = @{ action = 'pass' }
          Write-Log ('card busy, passed: ' + $id)
        }

        $res = @{ action = $decision.action }
        if ($decision.attachment) { $res.attachment = $decision.attachment }
        Write-Json (Join-Path $Ipc ('res-' + $id + '.json')) $res
        Write-Trace @{ ev = 'gate'; action = $decision.action; len = ([string]$req.text).Length }
        if ($decision.action -eq 'hold') { Show-Card $id $decision }
      } catch {
        # One malformed request or one failed window must not stop the gate.
        # Delete the unreadable request rather than retrying it every 40 ms:
        # it holds prompt text, and the plugin fails open on a missing verdict.
        Write-Log ('request failed: ' + $_.Exception.Message)
        try { Remove-Item -LiteralPath $file.FullName -Force } catch { }
      }
    }

    foreach ($name in @($script:Seen.Keys)) {
      if (-not (Test-Path -LiteralPath (Join-Path $Ipc $name))) { $script:Seen.Remove($name) }
    }

    if ($script:ActiveCard) {
      $card = $script:ActiveCard
      $dec = Join-Path $Ipc ('dec-' + $card.id + '.json')
      $req = Join-Path $Ipc ('req-' + $card.id + '.json')
      if ((Test-Path -LiteralPath $dec) -or -not (Test-Path -LiteralPath $req) -or (Get-Date) -gt $card.deadline) {
        Write-Log ('card closed: ' + $card.id)
        Close-Card
      }
    }

    Invoke-Pump 40
  }
} catch {
  Write-Log ('fatal: ' + $_.Exception.Message)
} finally {
  Close-Card
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $StopFile -Force -ErrorAction SilentlyContinue
  Write-Log 'daemon: stopped'
}
