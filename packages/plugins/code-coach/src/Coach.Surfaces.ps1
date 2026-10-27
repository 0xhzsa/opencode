# Coach.Surfaces.ps1 - which focused control is a prompt being written, and how to read it.
#
# Reads use UI Automation only: no clipboard, no keystrokes, no screen scraping.
# Password and sensitive controls are rejected before any read is attempted, and
# the classifier is written to reject by default: a window has to be a known
# terminal or a known IDE chat box to be accepted at all.

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not ('CoachSurfaceWin32' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CoachSurfaceWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int count);
  public static string RootClass(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return string.Empty;
    IntPtr root = GetAncestor(hwnd, 2);
    if (root == IntPtr.Zero) root = hwnd;
    StringBuilder sb = new StringBuilder(256);
    int n = GetClassName(root, sb, sb.Capacity);
    return n > 0 ? sb.ToString() : string.Empty;
  }
}
'@
}

# A terminal is identified by its top-level window class, not by a process name.
# A text box that happens to live in a powershell.exe process (a WPF app started
# from a shell) has an HwndWrapper class and must not be read as a console.
$script:TerminalWindowClasses = @(
  'ConsoleWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS', 'PseudoConsoleWindow',
  'VirtualConsoleClass', 'mintty', 'Alacritty', 'org.wezfurlong.wezterm'
)

# Processes whose focused text control is a command or prompt input.
$script:TerminalHosts = @(
  'WindowsTerminal', 'OpenConsole', 'conhost', 'powershell', 'pwsh', 'cmd',
  'wezterm-gui', 'alacritty', 'mintty', 'ConEmu64', 'ConEmu', 'Hyper', 'Tabby', 'comet'
)

# Processes whose chat panel is a prompt surface for an agent, not for a shell.
$script:IdeHosts = @('Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'idea64', 'pycharm64', 'rider64', 'studio64', 'webstorm64')

$script:PasswordManagerHosts = @('1Password', 'Bitwarden', 'KeePass', 'KeePassXC', 'LastPass', 'Dashlane', 'NordPass', 'Keeper', 'ProtonPass')

$script:SensitiveNamePattern = '(?i)(pass(word|wd|phrase)?|secret|api[ _-]?key|access[ _-]?key|private[ _-]?key|token|credential|cvv|cvc|card[ _-]?number|social[ _-]?security|ssn)'

$script:ChatNamePattern = '(?i)(chat|message|prompt|ask|assistant|composer|agent)'

$script:TextControlTypes = @('Edit', 'Document', 'Text')

function Test-SensitiveControl {
  param($Info)
  if ($Info.isPassword) { return @{ sensitive = $true; why = 'password-field' } }
  $name = ('{0} {1}' -f [string]$Info.name, [string]$Info.automationId)
  if ($name.Trim() -and $name -match $script:SensitiveNamePattern) {
    return @{ sensitive = $true; why = 'sensitive-name' }
  }
  if ($Info.process -and ($script:PasswordManagerHosts -contains [string]$Info.process)) {
    return @{ sensitive = $true; why = 'password-manager' }
  }
  return @{ sensitive = $false; why = $null }
}

# $Info: @{ isPassword; controlType; className; name; automationId; process; windowTitle; framework }
function Get-SurfaceVerdict {
  param([Parameter(Mandatory = $true)]$Info)

  $sensitive = Test-SensitiveControl $Info
  if ($sensitive.sensitive) {
    return @{ accept = $false; kind = 'none'; why = $sensitive.why }
  }

  $type = [string]$Info.controlType
  if ($script:TextControlTypes -notcontains $type) {
    return @{ accept = $false; kind = 'none'; why = 'not-a-text-control' }
  }

  $proc = [string]$Info.process
  if (-not $proc) { return @{ accept = $false; kind = 'none'; why = 'no-process' } }

  if ($script:TerminalHosts -contains $proc) {
    $wc = [string]$Info.windowClass
    $consoleClass = $wc -and ($script:TerminalWindowClasses -contains $wc)
    # Fall back to a Win32 framework only when the window class is unknown, so a
    # real console is never lost to a class-name change.
    if ($consoleClass -or (-not $wc -and [string]$Info.framework -eq 'Win32')) {
      return @{ accept = $true; kind = 'terminal'; why = 'terminal-host' }
    }
    return @{ accept = $false; kind = 'none'; why = 'terminal-host-not-console' }
  }

  if ($script:IdeHosts -contains $proc) {
    $name = ('{0} {1}' -f [string]$Info.name, [string]$Info.automationId)
    if ($name -match $script:ChatNamePattern) {
      return @{ accept = $true; kind = 'ide-chat'; why = 'ide-chat-panel' }
    }
    return @{ accept = $false; kind = 'none'; why = 'ide-not-chat' }
  }

  return @{ accept = $false; kind = 'none'; why = 'not-a-prompt-surface' }
}

function Get-ElementInfo($Element) {
  $info = @{
    isPassword   = $false
    controlType  = $null
    className    = $null
    name         = $null
    automationId = $null
    process      = $null
    windowTitle  = $null
    windowClass  = $null
    framework    = $null
  }
  if (-not $Element) { return $info }
  try { $info.isPassword = [bool]$Element.Current.IsPassword } catch { }
  try { $info.controlType = [string]$Element.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '' } catch { }
  try { $info.className = [string]$Element.Current.ClassName } catch { }
  try { $info.name = [string]$Element.Current.Name } catch { }
  try { $info.automationId = [string]$Element.Current.AutomationId } catch { }
  try { $info.framework = [string]$Element.Current.FrameworkId } catch { }
  try {
    $h = [IntPtr]$Element.Current.NativeWindowHandle
    if ($h -ne [IntPtr]::Zero) { $info.windowClass = [CoachSurfaceWin32]::RootClass($h) }
  } catch { }
  try {
    $procId = [int]$Element.Current.ProcessId
    $p = Get-Process -Id $procId -ErrorAction Stop
    $info.process = [string]$p.ProcessName
    if ($p.MainWindowTitle) { $info.windowTitle = [string]$p.MainWindowTitle }
  } catch { }
  return $info
}

function Get-TextFromElement($Element, [int]$MaxChars = 4000) {
  if (-not $Element) { return @{ ok = $false; text = $null; why = 'no-element' } }

  $vp = $null
  try {
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
      $v = [string]$vp.Current.Value
      if ($v.Length -gt $MaxChars) { $v = $v.Substring(0, $MaxChars) }
      return @{ ok = $true; text = $v; why = 'value' }
    }
  } catch { }

  $tp = $null
  try {
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
      $v = [string]$tp.DocumentRange.GetText($MaxChars)
      return @{ ok = $true; text = $v; why = 'text' }
    }
  } catch { }

  return @{ ok = $false; text = $null; why = 'no-text-pattern' }
}

# Terminals expose the whole buffer, not just the composer. The unsent line is the
# last line, and it is only usable if it has content and no trailing newline (a
# newline means it was already run). This is a heuristic and is labelled as one.
function Get-ComposerLine([string]$TerminalText) {
  if ([string]::IsNullOrEmpty($TerminalText)) { return $null }
  $t = $TerminalText.TrimEnd("`r", "`n")
  if ($t.Length -eq 0) { return $null }
  if ($TerminalText -match "`n$" -or $TerminalText -match "`r$") { return $null }
  $lines = $t -split "`r?`n"
  if ($lines.Count -eq 0) { return $null }
  $last = $lines[$lines.Count - 1].Trim()
  # Drop the shell prompt itself: the draft is what was typed after it.
  $last = $last -replace '^(PS [A-Za-z]:\\[^>]*>|PS>|[A-Za-z]:\\[^>]*>|\$|>|#)\s+', ''
  if ([string]::IsNullOrWhiteSpace($last)) { return $null }
  return $last.Trim()
}

function Get-FocusedSurface {
  $el = $null
  try { $el = [System.Windows.Automation.AutomationElement]::FocusedElement } catch { return $null }
  if (-not $el) { return $null }
  $info = Get-ElementInfo $el
  $verdict = Get-SurfaceVerdict $info
  return @{ element = $el; info = $info; verdict = $verdict }
}
