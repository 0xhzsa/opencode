# Coach.Card.ps1 - the card, built as a plain WPF visual so it can be rendered
# offscreen for every state without ever showing a window or taking focus.
# Live display wraps the same visual in a no-activate window (Coach.CardWindow.ps1).

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$script:CardWidth = 400.0
$script:CardPadding = 16.0
$script:SectionGap = 12.0
$script:RowGap = 8.0
$script:CardRadius = 10.0

function Get-RelativeLuminance([string]$Hex) {
  $h = $Hex.TrimStart('#')
  if ($h.Length -eq 8) { $h = $h.Substring(2) }
  $r = [Convert]::ToInt32($h.Substring(0, 2), 16) / 255.0
  $g = [Convert]::ToInt32($h.Substring(2, 2), 16) / 255.0
  $b = [Convert]::ToInt32($h.Substring(4, 2), 16) / 255.0
  $f = { param($c) if ($c -le 0.03928) { $c / 12.92 } else { [math]::Pow((($c + 0.055) / 1.055), 2.4) } }
  return (0.2126 * (& $f $r) + 0.7152 * (& $f $g) + 0.0722 * (& $f $b))
}

function Get-ContrastRatio([string]$A, [string]$B) {
  $la = Get-RelativeLuminance $A
  $lb = Get-RelativeLuminance $B
  $hi = [math]::Max($la, $lb)
  $lo = [math]::Min($la, $lb)
  return [math]::Round((($hi + 0.05) / ($lo + 0.05)), 2)
}

function Get-SystemAccent {
  try {
    $v = Get-ItemPropertyValue 'HKCU:\Software\Microsoft\Windows\DWM' -Name 'ColorizationColor' -ErrorAction Stop
    $s = ('{0:X8}' -f [uint32]$v)
    return ('#FF' + $s.Substring(2, 6))
  } catch {
    return '#FF0F6CBD'
  }
}

function Get-CardPalette([switch]$Dark, [switch]$HighContrast) {
  if ($HighContrast) {
    return @{
      bg = '#FF000000'; surface = '#FF1A1A1A'; border = '#FFFFFFFF'; text = '#FFFFFFFF'
      secondary = '#FFFFFFFF'; accent = '#FFFFFF00'; accentText = '#FF000000'; hairline = '#FFFFFFFF'
    }
  }
  if ($Dark) {
    return @{
      bg = '#FF1E2024'; surface = '#FF26292E'; border = '#FF3A3F46'; text = '#FFF2F4F7'
      secondary = '#FFC6CCD5'; accent = (Get-SystemAccent); accentText = $null; hairline = '#FF343941'
    }
  }
  return @{
    bg = '#FFFFFFFF'; surface = '#FFF6F7F9'; border = '#FFDDE1E6'; text = '#FF1B1F24'
    secondary = '#FF4F555D'; accent = (Get-SystemAccent); accentText = $null; hairline = '#FFE6E9ED'
  }
}

function Get-AccentTextColor([string]$Accent) {
  if ((Get-ContrastRatio '#FFFFFFFF' $Accent) -ge (Get-ContrastRatio '#FF111111' $Accent)) { return '#FFFFFFFF' }
  return '#FF111111'
}

function New-TextBlock([string]$Text, [double]$Size, [string]$Color, [string]$Weight = 'Normal') {
  $tb = New-Object System.Windows.Controls.TextBlock
  $tb.Text = $Text
  $tb.FontFamily = New-Object System.Windows.Media.FontFamily('Segoe UI Variable Text, Segoe UI')
  $tb.FontSize = $Size
  $tb.Foreground = (New-Object System.Windows.Media.BrushConverter).ConvertFromString($Color)
  $wmap = @{ Normal = [System.Windows.FontWeights]::Normal; SemiBold = [System.Windows.FontWeights]::SemiBold; Bold = [System.Windows.FontWeights]::Bold }
  $tb.FontWeight = $wmap[$Weight]
  $tb.TextWrapping = 'Wrap'
  $tb.TextTrimming = 'None'
  return $tb
}

# Hold the autohide countdown while the cursor sits over the card. Enter
# stops the tick; leaving restarts it with a full fresh interval. Only a
# still-running timer pauses, so a tick that already fired stays fired.
function Set-HoverHold([bool]$Held, $Timer) {
  if (-not $Timer) { return }
  if ($Held) {
    try { if ($Timer.IsEnabled) { [void]$Timer.Stop() } } catch { }
  } else {
    # Reloading an expired timer on leave is unreachable in production:
    # expiry closes the window, and a closed window's MouseLeave handler
    # goes with it. The tick guard ($script:Active null) is the backstop.
    try { if (-not $Timer.IsEnabled) { $Timer.Start() } } catch { }
  }
}

function Connect-HoverHold($Surface, $Timer) {
  if (-not $Surface -or -not $Timer) { return }
  # Script scope on purpose: the handlers outlive the caller's frame, and a
  # function-local would read $null at event time. The handler bodies are
  # stored too, so tests can invoke the real handlers instead of trying to
  # synthesize mouse events - which WPF refuses on detached visuals (direct
  # events type-check the invoked delegate).
  $script:HoverHoldTimer = $Timer
  $script:HoverHoldEnter = { try { Set-HoverHold $true $script:HoverHoldTimer } catch { } }
  $script:HoverHoldLeave = { try { Set-HoverHold $false $script:HoverHoldTimer } catch { } }
  $Surface.add_MouseEnter($script:HoverHoldEnter)
  $Surface.add_MouseLeave($script:HoverHoldLeave)
}

$script:ButtonTemplateXaml = @'
<ControlTemplate TargetType="Button" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Border x:Name="bd" CornerRadius="6" Background="{TemplateBinding Background}"
          BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}"
          Padding="{TemplateBinding Padding}">
    <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
  </Border>
  <ControlTemplate.Triggers>
    <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="bd" Property="Opacity" Value="0.9"/></Trigger>
    <Trigger Property="IsPressed" Value="True"><Setter TargetName="bd" Property="Opacity" Value="0.78"/></Trigger>
    <Trigger Property="IsEnabled" Value="False"><Setter TargetName="bd" Property="Opacity" Value="0.5"/></Trigger>
  </ControlTemplate.Triggers>
</ControlTemplate>
'@

function Set-CardButtonStyle {
  param($Button, [string]$Kind, $Palette)
  $p = $Palette
  $bc = New-Object System.Windows.Media.BrushConverter
  switch ($Kind) {
    'primary' {
      $Button.Background = $bc.ConvertFromString($p.accent)
      $fg = if ($p.accentText) { $p.accentText } else { Get-AccentTextColor $p.accent }
      $Button.Foreground = $bc.ConvertFromString($fg)
      $Button.BorderBrush = $bc.ConvertFromString($p.accent)
    }
    'outline' {
      $Button.Background = $bc.ConvertFromString($p.bg)
      $Button.Foreground = $bc.ConvertFromString($p.text)
      $Button.BorderBrush = $bc.ConvertFromString($p.border)
    }
    default {
      $Button.Background = [System.Windows.Media.Brushes]::Transparent
      $Button.Foreground = $bc.ConvertFromString($p.secondary)
      $Button.BorderBrush = [System.Windows.Media.Brushes]::Transparent
    }
  }
  $Button.BorderThickness = [System.Windows.Thickness]::new(1)
  $Button.Padding = [System.Windows.Thickness]::new(10, 6, 10, 6)
  $Button.FontFamily = New-Object System.Windows.Media.FontFamily('Segoe UI Variable Text, Segoe UI')
  $Button.FontSize = 12.5
  $Button.FontWeight = [System.Windows.FontWeights]::SemiBold
  $Button.MinHeight = 32
  $Button.Focusable = $false
  $Button.IsTabStop = $false
  $Button.Cursor = [System.Windows.Input.Cursors]::Hand
  $Button.Template = [System.Windows.Markup.XamlReader]::Parse($script:ButtonTemplateXaml)
  $Button.Margin = [System.Windows.Thickness]::new(6, 0, 0, 0)
}

function New-CardButton([string]$Text, [string]$AutomationName, [string]$Kind, $Palette) {
  $b = New-Object System.Windows.Controls.Button
  $b.Content = $Text
  [System.Windows.Automation.AutomationProperties]::SetName($b, $AutomationName)
  Set-CardButtonStyle $b $Kind $Palette
  return $b
}

function New-GapRow($Gap, $Palette) {
  $bc = New-Object System.Windows.Media.BrushConverter
  $border = New-Object System.Windows.Controls.Border
  $border.Background = $bc.ConvertFromString($Palette.surface)
  $border.CornerRadius = [System.Windows.CornerRadius]::new(6)
  $border.Padding = [System.Windows.Thickness]::new(8, 5, 8, 5)
  $border.Margin = [System.Windows.Thickness]::new(0, 0, 0, 4)

  $sp = New-Object System.Windows.Controls.StackPanel
  $sp.Orientation = 'Vertical'

  $label = New-TextBlock ([string]$Gap.label) 11 $Palette.secondary 'SemiBold'
  $text = New-TextBlock ([string]$Gap.text) 12.5 $Palette.text
  [void]$sp.Children.Add($label)
  [void]$sp.Children.Add($text)
  $border.Child = $sp
  return $border
}

# $Model shape:
#   kind        'prompt' | 'code'
#   consequence one line
#   gaps        @(@{ label; text })  - at most 3 shown
#   more        count of collapsed rows
#   addition    one exact guardrail sentence for a prompt card
#   followUp    text | $null (code follow-up)
#   attachment  text | $null (the context body a prompt card will attach)
#   find    @{ file; line; text } for the code card
#   lesson      text | $null
#   why         text | $null
#   sendsAsWritten  switch: the send proceeds if the card is ignored
#   countdownSeconds visible time before the send
#   quiet       switch
#   showWhy     switch
#   maxHeight   DIP cap for the whole card (default 0 = natural)
function New-CardVisual {
  param(
    [Parameter(Mandatory = $true)]$Model,
    [switch]$Dark,
    [switch]$HighContrast,
    [switch]$Quiet,
    [switch]$ShowWhy
  )
  $p = Get-CardPalette -Dark:$Dark -HighContrast:$HighContrast
  $bc = New-Object System.Windows.Media.BrushConverter

  $root = New-Object System.Windows.Controls.Border
  $root.Width = $script:CardWidth
  $root.CornerRadius = [System.Windows.CornerRadius]::new($script:CardRadius)
  $root.Background = $bc.ConvertFromString($p.bg)
  $root.BorderBrush = $bc.ConvertFromString($p.border)
  $root.BorderThickness = [System.Windows.Thickness]::new(1)
  $root.UseLayoutRounding = $true
  $root.SnapsToDevicePixels = $true
  [System.Windows.Automation.AutomationProperties]::SetName($root, 'Code Coach card')

  if (-not $HighContrast) {
    $shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
    $shadow.BlurRadius = 18
    $shadow.ShadowDepth = 4
    $shadow.Direction = 270
    $shadow.Opacity = if ($Dark) { 0.5 } else { 0.16 }
    $shadow.Color = [System.Windows.Media.Colors]::Black
    $root.Effect = $shadow
    $root.Margin = [System.Windows.Thickness]::new(10)
  }

  $grid = New-Object System.Windows.Controls.Grid
  $grid.RowDefinitions.Add((New-Object System.Windows.Controls.RowDefinition))
  $r2 = New-Object System.Windows.Controls.RowDefinition
  $r2.Height = 'Auto'
  $grid.RowDefinitions.Add($r2)

  # ---------- content ----------
  $content = New-Object System.Windows.Controls.StackPanel
  $content.Margin = [System.Windows.Thickness]::new($script:CardPadding, $script:CardPadding, $script:CardPadding, 10)

  # header
  $header = New-Object System.Windows.Controls.Grid
  $c1 = New-Object System.Windows.Controls.ColumnDefinition
  $c2 = New-Object System.Windows.Controls.ColumnDefinition
  $c2.Width = 'Auto'
  $header.ColumnDefinitions.Add($c1)
  $header.ColumnDefinitions.Add($c2)

  $titleText = 'Before this sends'
  if ($Model.kind -eq 'review') { $titleText = 'Quick review' }
  elseif ($Model.kind -eq 'nudge') {
    # U+26A0 as an escape, not a literal: a bare emoji in a .ps1 needs a BOM
    # for Windows PowerShell 5.1 to read it correctly.
    $titleText = [string][char]0x26A0 + ' Heads up'
  }
  $title = New-TextBlock $titleText 16 $p.text 'SemiBold'
  $title.VerticalAlignment = 'Center'
  [void]$header.Children.Add($title)

  $close = New-Object System.Windows.Controls.Button
  $close.Content = [string][char]0x00D7
  $close.ToolTip = 'Send original'
  if ($Model.kind -eq 'review') { $close.ToolTip = 'Dismiss review' }
  elseif ($Model.kind -eq 'nudge') { $close.ToolTip = 'Ignore' }
  [System.Windows.Automation.AutomationProperties]::SetName($close, 'Dismiss card')
  $close.Width = 28
  $close.Height = 24
  $close.Focusable = $false
  Set-CardButtonStyle $close 'ghost' $p
  $close.Margin = [System.Windows.Thickness]::new(0)
  $close.FontSize = 16
  $close.Padding = [System.Windows.Thickness]::new(0)
  $close.HorizontalAlignment = 'Right'
  [System.Windows.Controls.Grid]::SetColumn($close, 1)
  [void]$header.Children.Add($close)
  [void]$content.Children.Add($header)

  # consequence
  $cons = New-TextBlock ([string]$Model.consequence) 14 $p.text
  $cons.Margin = [System.Windows.Thickness]::new(0, 8, 0, 0)
  $cons.LineHeight = 20
  [void]$content.Children.Add($cons)

  if ($Model.principleName) {
    $pn = New-TextBlock ('PRINCIPLE  ' + ([string]$Model.principleName).ToUpperInvariant()) 10.5 $p.secondary 'SemiBold'
    $pn.Margin = [System.Windows.Thickness]::new(0, 6, 0, 0)
    [void]$content.Children.Add($pn)
  }

  # gap rows
  $gaps = @($Model.gaps)
  if (-not $Quiet -and $gaps.Count -gt 0) {
    $gapPanel = New-Object System.Windows.Controls.StackPanel
    $gapPanel.Margin = [System.Windows.Thickness]::new(0, $script:SectionGap, 0, 0)
    $shown = 0
    foreach ($g in $gaps) {
      if ($shown -ge 3) { break }
      [void]$gapPanel.Children.Add((New-GapRow $g $p))
      $shown++
    }
    if ($gaps.Count -gt 3) {
      $more = New-TextBlock (('+{0} more' -f ($gaps.Count - 3))) 11 $p.secondary
      $more.Margin = [System.Windows.Thickness]::new(8, 0, 0, 0)
      [void]$gapPanel.Children.Add($more)
    }
    [void]$content.Children.Add($gapPanel)
  }
  elseif ($Quiet -and $gaps.Count -gt 0) {
    $one = New-TextBlock ([string]$gaps[0].text) 12.5 $p.secondary
    $one.Margin = [System.Windows.Thickness]::new(0, 8, 0, 0)
    [void]$content.Children.Add($one)
  }

  # followUp / finding
  if ($Model.kind -eq 'code' -and $Model.finding) {
    $box = New-Object System.Windows.Controls.Border
    $box.Background = $bc.ConvertFromString($p.surface)
    $box.CornerRadius = [System.Windows.CornerRadius]::new(8)
    $box.Padding = [System.Windows.Thickness]::new(10, 8, 10, 8)
    $box.Margin = [System.Windows.Thickness]::new(0, $script:SectionGap, 0, 0)

    $sp = New-Object System.Windows.Controls.StackPanel
    $whereText = ('{0}:{1}' -f $Model.finding.file, $Model.finding.line)
    if ($Model.finding.symbol -and $Model.finding.symbol.name) { $whereText = $whereText + ' · ' + [string]$Model.finding.symbol.name }
    $where = New-TextBlock $whereText 12 $p.secondary 'SemiBold'
    $what = New-TextBlock ([string]$Model.finding.text) 12.5 $p.text
    $what.Margin = [System.Windows.Thickness]::new(0, 4, 0, 0)
    [void]$sp.Children.Add($where)
    [void]$sp.Children.Add($what)
    $box.Child = $sp
    [void]$content.Children.Add($box)
  }

  $attachText = [string]$Model.attachment
  if ($Model.kind -eq 'prompt' -and $attachText) {
    $box = New-Object System.Windows.Controls.Border
    $box.Background = $bc.ConvertFromString($p.surface)
    $box.CornerRadius = [System.Windows.CornerRadius]::new(8)
    $box.Padding = [System.Windows.Thickness]::new(10, 8, 10, 8)
    $box.Margin = [System.Windows.Thickness]::new(0, $script:SectionGap, 0, 0)

    $sp = New-Object System.Windows.Controls.StackPanel
    $label = New-TextBlock 'WILL BE ATTACHED' 10.5 $p.secondary 'SemiBold'
    $sv = New-Object System.Windows.Controls.ScrollViewer
    $sv.VerticalScrollBarVisibility = 'Auto'
    $sv.HorizontalScrollBarVisibility = 'Disabled'
    $sv.Focusable = $false
    $sv.MaxHeight = if ($Quiet) { 80 } else { 200 }
    $sv.Margin = [System.Windows.Thickness]::new(0, 5, 0, 0)

    $tb = New-Object System.Windows.Controls.TextBox
    $tb.Text = $attachText
    $tb.IsReadOnly = $true
    $tb.AcceptsReturn = $true
    $tb.TextWrapping = 'Wrap'
    $tb.BorderThickness = [System.Windows.Thickness]::new(0)
    $tb.Background = [System.Windows.Media.Brushes]::Transparent
    $tb.Foreground = $bc.ConvertFromString($p.text)
    $tb.FontFamily = New-Object System.Windows.Media.FontFamily('Segoe UI Variable Text, Segoe UI')
    $tb.FontSize = 12.5
    $tb.Padding = [System.Windows.Thickness]::new(0)
    $tb.IsTabStop = $false
    $tb.Focusable = $false
    [System.Windows.Automation.AutomationProperties]::SetName($tb, 'Attached context')
    $sv.Content = $tb
    [void]$sp.Children.Add($label)
    [void]$sp.Children.Add($sv)
    $note = New-TextBlock 'Attached to the send. Your words stay as written.' 10.5 $p.secondary
    $note.Margin = [System.Windows.Thickness]::new(0, 5, 0, 0)
    $note.LineHeight = 15
    [void]$sp.Children.Add($note)
    $box.Child = $sp
    [void]$content.Children.Add($box)
  } elseif ($Model.kind -eq 'code' -and $Model.followUp) {
    $box = New-Object System.Windows.Controls.Border
    $box.Background = $bc.ConvertFromString($p.surface)
    $box.CornerRadius = [System.Windows.CornerRadius]::new(8)
    $box.Padding = [System.Windows.Thickness]::new(10, 8, 10, 8)
    $box.Margin = [System.Windows.Thickness]::new(0, $script:SectionGap, 0, 0)

    $sp = New-Object System.Windows.Controls.StackPanel
    $label = New-TextBlock 'SUGGESTED FOLLOW-UP' 10.5 $p.secondary 'SemiBold'
    $sv = New-Object System.Windows.Controls.ScrollViewer
    $sv.VerticalScrollBarVisibility = 'Auto'
    $sv.HorizontalScrollBarVisibility = 'Disabled'
    $sv.Focusable = $false
    $sv.MaxHeight = if ($Quiet) { 64 } else { 160 }
    $sv.Margin = [System.Windows.Thickness]::new(0, 5, 0, 0)

    $tb = New-Object System.Windows.Controls.TextBox
    $tb.Text = [string]$Model.followUp
    $tb.IsReadOnly = $true
    $tb.AcceptsReturn = $true
    $tb.TextWrapping = 'Wrap'
    $tb.BorderThickness = [System.Windows.Thickness]::new(0)
    $tb.Background = [System.Windows.Media.Brushes]::Transparent
    $tb.Foreground = $bc.ConvertFromString($p.text)
    $tb.FontFamily = New-Object System.Windows.Media.FontFamily('Segoe UI Variable Text, Segoe UI')
    $tb.FontSize = 12.5
    $tb.Padding = [System.Windows.Thickness]::new(0)
    $tb.IsTabStop = $false
    $tb.Focusable = $false
    [System.Windows.Automation.AutomationProperties]::SetName($tb, 'Follow-up prompt')
    $sv.Content = $tb
    [void]$sp.Children.Add($label)
    [void]$sp.Children.Add($sv)
    $box.Child = $sp
    [void]$content.Children.Add($box)
  } elseif ($Model.addition) {
    $box = New-Object System.Windows.Controls.Border
    $box.Background = $bc.ConvertFromString($p.surface)
    $box.CornerRadius = [System.Windows.CornerRadius]::new(8)
    $box.Padding = [System.Windows.Thickness]::new(10, 8, 10, 8)
    $box.Margin = [System.Windows.Thickness]::new(0, $script:SectionGap, 0, 0)

    $sp = New-Object System.Windows.Controls.StackPanel
    $addLabel = if ($Model.kind -eq 'review') { 'ANSWER' } else { 'GUARDRAIL' }
    $label = New-TextBlock $addLabel 10.5 $p.secondary 'SemiBold'
    $add = New-TextBlock ([string]$Model.addition) 13 $p.text
    $add.Margin = [System.Windows.Thickness]::new(0, 4, 0, 0)
    $add.LineHeight = 19
    [void]$sp.Children.Add($label)
    [void]$sp.Children.Add($add)
    $box.Child = $sp
    [void]$content.Children.Add($box)
  }

  # When the attachment is previewed above, it already carries the approach and
  # the check. Repeating them as a second list makes the card look like two
  # different plans.
  $attachmentShown = ($Model.kind -eq 'prompt' -and -not [string]::IsNullOrWhiteSpace([string]$Model.attachment))
  $approachItems = @($Model.approach | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
  if (-not $Quiet -and -not $attachmentShown -and $approachItems.Count -gt 0) {
    $ap = New-Object System.Windows.Controls.StackPanel
    $ap.Margin = [System.Windows.Thickness]::new(0, $script:SectionGap, 0, 0)
    $al = New-TextBlock 'SUGGESTED APPROACH' 10.5 $p.secondary 'SemiBold'
    [void]$ap.Children.Add($al)
    $n = 0
    foreach ($a in $approachItems) {
      if ($n -ge 3) { break }
      $t = New-TextBlock ('• ' + [string]$a) 12 $p.text
      $t.Margin = [System.Windows.Thickness]::new(0, 4, 0, 0)
      $t.LineHeight = 17
      [void]$ap.Children.Add($t)
      $n++
    }
    [void]$content.Children.Add($ap)
  }

  $groundingItems = @($Model.grounding | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
  if (-not $Quiet -and $groundingItems.Count -gt 0) {
    $gp = New-Object System.Windows.Controls.StackPanel
    $gp.Margin = [System.Windows.Thickness]::new(0, $script:SectionGap, 0, 0)
    $gl = New-TextBlock 'WHAT I USED' 10.5 $p.secondary 'SemiBold'
    [void]$gp.Children.Add($gl)
    $n = 0
    foreach ($g in $groundingItems) {
      if ($n -ge 3) { break }
      $t = New-TextBlock ('• ' + [string]$g) 11.5 $p.secondary
      $t.Margin = [System.Windows.Thickness]::new(0, 3, 0, 0)
      $t.LineHeight = 16
      [void]$gp.Children.Add($t)
      $n++
    }
    [void]$content.Children.Add($gp)
  }

  # lesson / why
  $whyText = if ($Model.why) { [string]$Model.why } else { [string]$Model.lesson }
  if ($whyText -and ($ShowWhy -or $Model.showWhy)) {
    $why = New-Object System.Windows.Controls.Border
    $why.BorderBrush = $bc.ConvertFromString($p.hairline)
    $why.BorderThickness = [System.Windows.Thickness]::new(0, 1, 0, 0)
    $why.Padding = [System.Windows.Thickness]::new(0, 10, 0, 0)
    $why.Margin = [System.Windows.Thickness]::new(0, $script:SectionGap, 0, 0)
    $wsp = New-Object System.Windows.Controls.StackPanel
    $wl = New-TextBlock 'WHY' 10.5 $p.secondary 'SemiBold'
    $wl.Margin = [System.Windows.Thickness]::new(0, 0, 0, 4)
    $wt = New-TextBlock $whyText 12.5 $p.secondary
    $wt.LineHeight = 18
    [void]$wsp.Children.Add($wl)
    [void]$wsp.Children.Add($wt)
    $why.Child = $wsp
    [void]$content.Children.Add($why)
  }

  # footer meta. Only the local gate may claim that nothing leaves the machine;
  # a nudge is a model verdict and the model can be a remote provider, so its
  # footer names the model instead. The rule lives here, not at the call site,
  # so a new caller cannot reintroduce the false claim.
  $meta = New-Object System.Windows.Controls.StackPanel
  $meta.Orientation = 'Horizontal'
  $meta.Margin = [System.Windows.Thickness]::new(0, 10, 0, 0)
  $footPrefix = [string]$Model.footerPrefix
  if (-not $footPrefix) { $footPrefix = if ([string]$Model.kind -eq 'nudge') { 'Triage' } else { 'Local' } }
  $footNote = [string]$Model.footerNote
  if (-not $footNote) {
    $footNote = if ([string]$Model.kind -eq 'nudge') { 'draft sent to your configured model' } else { 'nothing leaves this machine' }
  }
  # A nudge judged from the prompt alone says so: the developer is about to read
  # a claim that had no file facts behind it, and the footer must not let it pass
  # for a repo-level finding. Enforced here, like the locality rule, so a call
  # site cannot forget it.
  if ([string]$Model.kind -eq 'nudge' -and [string]$Model.groundingKind -eq 'prompt' -and $footNote -notmatch 'prompt-grounded') {
    $footNote += ' (prompt-grounded)'
  }
  $local = New-TextBlock $footPrefix 10.5 $p.secondary
  $local.VerticalAlignment = 'Center'
  $dot = New-TextBlock ([char]0x2022) 9 $p.secondary
  $dot.Margin = [System.Windows.Thickness]::new(4, 0, 4, 0)
  $dot.VerticalAlignment = 'Center'
  [void]$meta.Children.Add($local)
  [void]$meta.Children.Add($dot)
  if ($Model.sendsAsWritten -and [int]$Model.countdownSeconds -gt 0) {
    [void]$meta.Children.Add((New-TextBlock ('sends as written in {0}s' -f [int]$Model.countdownSeconds) 10.5 $p.secondary))
  } else {
    [void]$meta.Children.Add((New-TextBlock $footNote 10.5 $p.secondary))
  }
  [void]$content.Children.Add($meta)

  $scroll = New-Object System.Windows.Controls.ScrollViewer
  $scroll.VerticalScrollBarVisibility = 'Auto'
  $scroll.HorizontalScrollBarVisibility = 'Disabled'
  $scroll.Focusable = $false
  $scroll.Content = $content
  [void]$grid.Children.Add($scroll)

  # ---------- footer buttons ----------
  $footer = New-Object System.Windows.Controls.Border
  $footer.BorderBrush = $bc.ConvertFromString($p.hairline)
  $footer.BorderThickness = [System.Windows.Thickness]::new(0, 1, 0, 0)
  $footer.Padding = [System.Windows.Thickness]::new(12, 10, 12, 12)
  [System.Windows.Controls.Grid]::SetRow($footer, 1)

  $row = New-Object System.Windows.Controls.StackPanel
  $row.Orientation = 'Horizontal'
  $row.HorizontalAlignment = 'Right'

  if ($Model.kind -eq 'review') {
    [void]$row.Children.Add((New-CardButton 'Got it' 'Got it' 'primary' $p))
    [void]$row.Children.Add((New-CardButton 'Not yet' 'Not yet' 'ghost' $p))
  } elseif ($Model.kind -eq 'nudge') {
    # The spec's three actions, in order. Fix my prompt is the money action
    # (primary); it is only honest when the model actually produced a better
    # prompt, so an empty one arrives disabled.
    $fixBtn = New-CardButton 'Fix my prompt' 'Fix my prompt' 'primary' $p
    if (-not ([string]$Model.betterPrompt).Trim()) { $fixBtn.IsEnabled = $false }
    [void]$row.Children.Add((New-CardButton 'Explain why' 'Explain why' 'outline' $p))
    [void]$row.Children.Add($fixBtn)
    [void]$row.Children.Add((New-CardButton 'Ignore' 'Ignore' 'ghost' $p))
    [void]$row.Children.Add((New-CardButton 'Snooze' 'Snooze' 'ghost' $p))
  } elseif ($Model.kind -eq 'code') {
    [void]$row.Children.Add((New-CardButton 'Copy follow-up' 'Copy follow-up prompt' 'primary' $p))
    [void]$row.Children.Add((New-CardButton 'Dismiss' 'Dismiss card' 'ghost' $p))
  } else {
    if ($Model.smart) {
      [void]$row.Children.Add((New-CardButton 'Attach to send' 'Attach to send' 'primary' $p))
    } else {
      [void]$row.Children.Add((New-CardButton 'Add guardrail' 'Add the guardrail' 'primary' $p))
    }
    [void]$row.Children.Add((New-CardButton 'Copy prompt' 'Copy prompt' 'outline' $p))
    [void]$row.Children.Add((New-CardButton 'Send original' 'Send original' 'ghost' $p))
  }
  $footer.Child = $row
  [void]$grid.Children.Add($footer)

  $root.Child = $grid

  if ($Model.maxHeight -and [double]$Model.maxHeight -gt 0) {
    $root.MaxHeight = [double]$Model.maxHeight
  }
  return $root
}

# ---------------------------------------------------------------------------
# Placement: pure geometry, tested without a screen.
# Returns @{ left; top; side } in virtual-screen pixels.
# ---------------------------------------------------------------------------
function Get-CardPlacement {
  param(
    [Parameter(Mandatory = $true)]$Composer,   # @{ left; top; right; bottom }
    [Parameter(Mandatory = $true)]$WorkArea,   # @{ left; top; right; bottom }
    [Parameter(Mandatory = $true)][double]$CardWidth,
    [Parameter(Mandatory = $true)][double]$CardHeight,
    [double]$Gap = 12
  )
  $waLeft = [double]$WorkArea.left
  $waTop = [double]$WorkArea.top
  $waRight = [double]$WorkArea.right
  $waBottom = [double]$WorkArea.bottom

  $rightSpace = $waRight - $Composer.right
  $leftSpace = $Composer.left - $waLeft
  $aboveSpace = $Composer.top - $waTop
  $belowSpace = $waBottom - $Composer.bottom

  $side = $null
  $left = $null
  $top = $null

  if ($rightSpace -ge ($CardWidth + $Gap)) {
    $side = 'right'
    $left = $Composer.right + $Gap
    $top = $Composer.top
  } elseif ($leftSpace -ge ($CardWidth + $Gap)) {
    $side = 'left'
    $left = $Composer.left - $CardWidth - $Gap
    $top = $Composer.top
  } elseif ($aboveSpace -ge ($CardHeight + $Gap)) {
    $side = 'above'
    $left = $Composer.left
    $top = $Composer.top - $CardHeight - $Gap
  } elseif ($belowSpace -ge ($CardHeight + $Gap)) {
    $side = 'below'
    $left = $Composer.left
    $top = $Composer.bottom + $Gap
  } else {
    $side = 'corner'
    $left = $waRight - $CardWidth - $Gap
    $top = $waTop + $Gap
  }

  if ($left -lt $waLeft) { $left = $waLeft }
  if ($top -lt $waTop) { $top = $waTop }
  if (($left + $CardWidth) -gt $waRight) { $left = $waRight - $CardWidth }
  if (($top + $CardHeight) -gt $waBottom) { $top = $waBottom - $CardHeight }

  return @{ left = [math]::Round($left); top = [math]::Round($top); side = $side }
}

function Test-CardClearsComposer($Placement, $Composer, [double]$CardWidth, [double]$CardHeight) {
  $cl = [double]$Placement.left; $ct = [double]$Placement.top
  $cr = $cl + $CardWidth; $cb = $ct + $CardHeight
  $overlapX = ($cl -lt $Composer.right) -and ($cr -gt $Composer.left)
  $overlapY = ($ct -lt $Composer.bottom) -and ($cb -gt $Composer.top)
  return -not ($overlapX -and $overlapY)
}
