# Coach.CardWindow.ps1 - shows the card in a window that cannot take focus.
# WS_EX_NOACTIVATE + ShowActivated=false + MA_NOACTIVATE on WM_MOUSEACTIVATE,
# which is what makes a click on the card leave the caret where it was.

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not ('CoachWin32' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CoachWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int nValue);
  [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
    public int cbSize; public int flags;
    public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture;
    public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public RECT rcCaret;
  }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  // SetForegroundWindow refuses when the caller is not foreground; attaching to the
  // target's input queue lifts that restriction for the one call we need.
  public static bool ForceForeground(IntPtr target) {
    if (target == IntPtr.Zero) return false;
    if (SetForegroundWindow(target)) return true;
    uint pid; uint targetThread = GetWindowThreadProcessId(target, out pid);
    uint me = GetCurrentThreadId();
    if (targetThread != 0 && targetThread != me && AttachThreadInput(me, targetThread, true)) {
      bool ok = SetForegroundWindow(target);
      AttachThreadInput(me, targetThread, false);
      return ok;
    }
    return false;
  }
}
'@
}

$script:GWL_EXSTYLE = -20
$script:WS_EX_NOACTIVATE = 0x08000000
$script:WS_EX_TOOLWINDOW = 0x00000080
$script:WM_MOUSEACTIVATE = 0x0021
$script:MA_NOACTIVATE = 3
$script:WDA_EXCLUDEFROMCAPTURE = 0x00000011
$script:CoachRestoreHwnd = [IntPtr]::Zero
$script:CoachCardHwnd = [IntPtr]::Zero

function New-CoachCardWindow {
  param([Parameter(Mandatory = $true)]$Model, [switch]$Dark, [switch]$HighContrast)

  $win = New-Object System.Windows.Window
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
  $win.Content = (New-CardVisual -Model $Model -Dark:$Dark -HighContrast:$HighContrast)
  return $win
}

function Initialize-CoachWindowChrome([Parameter(Mandatory = $true)]$Window) {
  $helper = New-Object System.Windows.Interop.WindowInteropHelper($Window)
  [void]$helper.EnsureHandle()
  $hwnd = $helper.Handle
  $ex = [CoachWin32]::GetWindowLong($hwnd, $script:GWL_EXSTYLE)
  [void][CoachWin32]::SetWindowLong($hwnd, $script:GWL_EXSTYLE, ($ex -bor $script:WS_EX_NOACTIVATE -bor $script:WS_EX_TOOLWINDOW))

  $source = [System.Windows.Interop.HwndSource]::FromHwnd($hwnd)
  if ($source) {
    [void]$source.AddHook({
      param($h, $msg, $w, $l, [ref]$handled)
      if ($msg -eq 0x0021) {
        $handled.Value = $true
        return [IntPtr]::new(3)
      }
      # WM_ACTIVATE: UIA invoke (and anything else that calls SetFocus) forces this
      # window active. Hand the foreground straight back to whatever had it. The
      # old code checked GetForegroundWindow() first, but during the transition it
      # reports 0, so the check skipped the restore. Restore unconditionally.
      if ($msg -eq 0x0006) {
        try {
          $word = ([int]$w) -band 0xFFFF
          if ($word -ne 0 -and $script:CoachRestoreHwnd -ne [IntPtr]::Zero -and $script:CoachRestoreHwnd -ne $h) {
            [void][CoachWin32]::ForceForeground($script:CoachRestoreHwnd)
          }
        } catch { }
      }
      return [IntPtr]::Zero
    })
  }
  return $hwnd
}

function Set-CoachCaptureExclusion {
  param([Parameter(Mandatory = $true)][IntPtr]$Handle, [bool]$On = $true)
  if (-not $On) {
    return [CoachWin32]::SetWindowDisplayAffinity($Handle, 0)
  }
  $ok = [CoachWin32]::SetWindowDisplayAffinity($Handle, $script:WDA_EXCLUDEFROMCAPTURE)
  if (-not $ok) { $ok = [CoachWin32]::SetWindowDisplayAffinity($Handle, 0x00000001) }
  return $ok
}

function Show-CoachCardWindow {
  param(
    [Parameter(Mandatory = $true)]$Model,
    [Parameter(Mandatory = $true)]$Placement,
    [switch]$Dark,
    [bool]$ExcludeFromCapture = $true,
    [switch]$HighContrast
  )
  $script:CoachRestoreHwnd = [CoachWin32]::GetForegroundWindow()
  $win = New-CoachCardWindow -Model $Model -Dark:$Dark -HighContrast:$HighContrast
  $hwnd = Initialize-CoachWindowChrome $win
  $win.Left = [double]$Placement.left
  $win.Top = [double]$Placement.top
  [void](Set-CoachCaptureExclusion -Handle $hwnd -On $ExcludeFromCapture)
  $win.Show()

  # Belt and braces: after the first forced activation, the window manager can stop
  # sending WM_ACTIVATE while WPF still believes it is active, so a later UIA invoke
  # moves the foreground with no message to react to. This guard only exists while a
  # card is on screen (a few seconds) and puts the foreground back if it moved.
  $guard = New-Object System.Windows.Threading.DispatcherTimer
  $guard.Interval = [TimeSpan]::FromMilliseconds(100)
  # Script scope on purpose: a function-local captured by the tick resolves to $null
  # once Show returns, which silently disables the guard.
  $script:CoachCardHwnd = $hwnd
  $guard.add_Tick({
    try {
      if ($script:CoachRestoreHwnd -ne [IntPtr]::Zero -and $script:CoachCardHwnd -ne [IntPtr]::Zero -and
          [CoachWin32]::GetForegroundWindow() -eq $script:CoachCardHwnd) {
        [void][CoachWin32]::ForceForeground($script:CoachRestoreHwnd)
      }
    } catch { }
  })
  $guard.Start()

  return @{ window = $win; hwnd = $hwnd; guard = $guard; style = [CoachWin32]::GetWindowLong($hwnd, $script:GWL_EXSTYLE) }
}

function Close-CoachCardWindow($Card) {
  if (-not $Card) { return }
  try { if ($Card.guard) { $Card.guard.Stop() } } catch { }
  try { $Card.window.Close() } catch { }
}

function Get-FocusSnapshot {
  $fg = [CoachWin32]::GetForegroundWindow()
  $focus = [IntPtr]::Zero
  try {
    $procId = [uint32]0
    $tid = [CoachWin32]::GetWindowThreadProcessId($fg, [ref]$procId)
    $gti = New-Object 'CoachWin32+GUITHREADINFO'
    $gti.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($gti)
    if ([CoachWin32]::GetGUIThreadInfo($tid, [ref]$gti)) { $focus = $gti.hwndFocus }
  } catch { }
  return @{ hwnd = [int64]$fg; focus = [int64]$focus }
}

function Invoke-CardButtonByName {
  param([Parameter(Mandatory = $true)][IntPtr]$Handle, [Parameter(Mandatory = $true)][string]$Name)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($Handle)
  if (-not $root) { return $false }
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $Name)
  $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if (-not $el) { return $false }
  $pattern = $null
  if (-not $el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { return $false }
  $pattern.Invoke()
  return $true
}
