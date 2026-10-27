# Coach.Daemon.ps1 - slice 1 of the code-coach gate.
#
# Watches the IPC folder for req-<id>.json, decides whether the ask destroys
# state with no recovery point, and - if it does - shows one card with
# "Copy the guardrail" and "Dismiss".
#
# This process never talks back to the plugin. The plugin does not wait for it,
# so nothing here can delay or change a send. The card is a nudge after the
# fact: it copies a guardrail to the clipboard so the developer can paste it
# into the conversation, or dismisses itself.
#
# One deterministic rule:
#   destructive verb + destructive object, no recovery point -> card
#   hard pattern (rm -rf, git clean, force-push, drop table) -> card
#   anything else                                            -> silence
#
# One card at a time. A second destructive ask while a card is up is dropped
# and logged rather than stacked.
#
# Nothing here reads or writes the prompt itself beyond matching the rule, and
# no prompt text is ever logged or traced.

param([switch]$Once)

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

# How long a card stays up. Hovering pauses the countdown. The card is the only
# interruption this slice can produce, so it gets long enough to actually read.
$CardSeconds = 60
# A request older than this belongs to a session that has moved on. Answering it
# with a card would be a nudge about something the developer finished minutes ago.
$MaxRequestAgeSeconds = 120

New-Item -ItemType Directory -Force -Path $Ipc, $LogDir | Out-Null

# Windows PowerShell 5.1's `Set-Content -Encoding UTF8` writes a BOM. Everything
# this daemon writes is read by Node or by ConvertFrom-Json, so write UTF-8
# without one.
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

$script:Guardrail = 'Before you delete or rewrite anything, commit the current state, take a backup, and run the change against one target first; confirm the result before widening it.'

function Test-Destructive([string]$Text) {
  $t = [string]$Text
  if (-not $t) { return $false }
  # A recovery point in the ask is the whole point of the rule.
  if ($t -match $script:ReGuard) { return $false }
  if ($t -match $script:ReHard) { return $true }
  return (($t -match $script:ReVerb) -and ($t -match $script:ReObject))
}

$script:ActiveCard = $null
$script:PumpFrame = $null
$script:Seen = @{}

function Close-Card {
  $card = $script:ActiveCard
  if (-not $card) { return }
  $script:ActiveCard = $null
  try { if ($card.timer) { $card.timer.Stop() } } catch { }
  try { $card.window.Close() } catch { }
}

function Set-ClipboardText([string]$Text) {
  # Another process can hold the clipboard open for a few milliseconds; a
  # single throw would lose the copy and leave the card up with no feedback.
  for ($i = 0; $i -lt 5; $i++) {
    try {
      [System.Windows.Clipboard]::SetText($Text)
      return $true
    } catch {
      Start-Sleep -Milliseconds 40
    }
  }
  return $false
}

function Complete-Card([string]$Action) {
  $card = $script:ActiveCard
  if (-not $card) { return }
  try {
    if ($Action -eq 'copy') {
      $ok = Set-ClipboardText $script:Guardrail
      Write-Trace @{ ev = 'card_action'; action = 'copy'; ok = $ok }
      Write-Log ('card: copy ' + $(if ($ok) { 'ok' } else { 'failed' }))
    } else {
      Write-Trace @{ ev = 'card_action'; action = 'dismiss' }
      Write-Log 'card: dismissed'
    }
  } catch {
    Write-Log ('card action failed: ' + $_.Exception.Message)
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

function Show-Card([string]$Id, [string]$Text) {
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
  $title.Text = 'Destructive ask without a recovery point'
  $title.FontSize = 15
  $title.FontWeight = 'SemiBold'
  $title.TextWrapping = 'Wrap'
  [void]$panel.Children.Add($title)

  $body = New-Object System.Windows.Controls.TextBlock
  $body.Text = 'This deletes or rewrites state, and nothing in the ask makes it reversible. Copy the guardrail and paste it into the conversation.'
  $body.FontSize = 12
  $body.Margin = '0,6,0,0'
  $body.TextWrapping = 'Wrap'
  [void]$panel.Children.Add($body)

  $meta = New-Object System.Windows.Controls.TextBlock
  $meta.FontSize = 10.5
  $meta.Margin = '0,8,0,0'
  $meta.Foreground = [System.Windows.Media.Brushes]::Gray
  [void]$panel.Children.Add($meta)

  $row = New-Object System.Windows.Controls.StackPanel
  $row.Orientation = 'Horizontal'
  $row.Margin = '0,12,0,0'

  $copy = New-Object System.Windows.Controls.Button
  $copy.Content = 'Copy the guardrail'
  $copy.Padding = '10,4'
  $copy.Add_Click({ Complete-Card 'copy' })
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($copy, 'CoachCopyGuardrail')
  [void]$row.Children.Add($copy)

  $dismiss = New-Object System.Windows.Controls.Button
  $dismiss.Content = 'Dismiss'
  $dismiss.Padding = '10,4'
  $dismiss.Margin = '8,0,0,0'
  $dismiss.Add_Click({ Complete-Card 'dismiss' })
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($dismiss, 'CoachDismiss')
  [void]$row.Children.Add($dismiss)

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

  $script:ActiveCard = @{ id = $Id; window = $win; timer = $null }

  # Hovering stops the countdown so a card can be read at the reader's pace.
  $timer = New-Object System.Windows.Threading.DispatcherTimer
  $timer.Interval = [TimeSpan]::FromSeconds($CardSeconds)
  $timer.add_Tick({
    Write-Log 'card: expired'
    Write-Trace @{ ev = 'card_expired' }
    Close-Card
  })
  $timer.Start()
  $script:ActiveCard.timer = $timer
  $script:ActiveCard.meta = $meta
  $meta.Text = ('dismisses in {0}s' -f $CardSeconds)

  $win.add_MouseEnter({ try { if ($script:ActiveCard -and $script:ActiveCard.timer) { $script:ActiveCard.timer.Stop(); $script:ActiveCard.meta.Text = 'paused while you read' } } catch { } })
  $win.add_MouseLeave({ try { if ($script:ActiveCard -and $script:ActiveCard.timer) { $script:ActiveCard.timer.Start(); $script:ActiveCard.meta.Text = ('dismisses in {0}s' -f $CardSeconds) } } catch { } })

  Write-Log 'card up'
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
        $age = ((Get-Date) - $file.LastWriteTime).TotalSeconds
        if ($age -gt $MaxRequestAgeSeconds) {
          Write-Log ('request stale, dropped age=' + [int]$age)
          Write-Trace @{ ev = 'request_stale' }
          Remove-Item -LiteralPath $file.FullName -Force
          continue
        }

        $req = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction Stop | ConvertFrom-Json
        $id = [string]$req.id
        $text = [string]$req.text

        # Delete first: the plugin never reads this back, and a card that is
        # about to appear must not depend on a file the loop might re-read.
        Remove-Item -LiteralPath $file.FullName -Force

        if (-not (Test-Destructive $text)) {
          Write-Trace @{ ev = 'silent'; len = $text.Length }
          continue
        }

        if ($script:ActiveCard) {
          Write-Log 'card busy, dropped'
          Write-Trace @{ ev = 'card_dropped'; len = $text.Length }
          continue
        }

        Show-Card $id $text
      } catch {
        # One malformed request must not stop the gate. The file holds prompt
        # text, so remove it rather than retrying it every 40 ms.
        Write-Log ('request failed: ' + $_.Exception.Message)
        try { Remove-Item -LiteralPath $file.FullName -Force } catch { }
      }
    }

    foreach ($name in @($script:Seen.Keys)) {
      if (-not (Test-Path -LiteralPath (Join-Path $Ipc $name))) { $script:Seen.Remove($name) }
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
