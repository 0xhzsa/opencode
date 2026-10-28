# uia-observer.ps1 - emits JSON lines describing the focused Edit control.
#
# Read-only: uses Windows UI Automation (the accessibility API screen readers
# use). It never installs a keyboard hook and never writes to disk or network.
# The adapter emits a prompt when a field is cleared (submit) or loses focus,
# not on every keystroke.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$script:lastKey = ""
$script:lastText = ""
$script:lastEmit = ""
$script:apps = @{}

function Get-AppName([int]$processId) {
  if ($script:apps.ContainsKey($processId)) { return $script:apps[$processId] }
  $name = ""
  try {
    $p = Get-Process -Id $processId -ErrorAction Stop
    $name = [string]$p.ProcessName
  } catch {}
  $script:apps[$processId] = $name
  return $name
}

function Emit-Prompt([string]$eventName, [string]$app, [string]$title, [string]$text) {
  if ([string]::IsNullOrWhiteSpace($text)) { return }
  if ($text.Length -lt 8 -or $text.Length -gt 2000) { return }
  $obj = [ordered]@{
    event = $eventName
    app = $app
    title = $title
    control = "ControlType.Edit"
    text = $text
  }
  $json = $obj | ConvertTo-Json -Compress
  if ($json -eq $script:lastEmit) { return }
  $script:lastEmit = $json
  Write-Output $json
  [Console]::Out.Flush()
}

while ($true) {
  try {
    $el = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -ne $el) {
      $controlType = [string]$el.Current.ControlType.ProgrammaticName
      $processId = [int]$el.Current.ProcessId
      $app = Get-AppName $processId
      $title = [string]$el.Current.Name
      $key = "$processId|$controlType|$title"

      if ($controlType -eq "ControlType.Edit") {
        $text = ""
        $valuePattern = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
          $text = [string]$valuePattern.Current.Value
        } else {
          $textPattern = $null
          if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$textPattern)) {
            $text = [string]$textPattern.DocumentRange.GetText(2000)
          }
        }
        $text = $text.Trim()

        if ($text.Length -gt 0) {
          if ($script:lastText.Length -gt 0 -and $key -ne $script:lastKey) {
            Emit-Prompt "blurred" $app $title $script:lastText
          }
          $script:lastText = $text
          $script:lastKey = $key
        } elseif ($script:lastText.Length -gt 0) {
          Emit-Prompt "submitted" $app $title $script:lastText
          $script:lastText = ""
          $script:lastKey = ""
        }
      } elseif ($script:lastText.Length -gt 0) {
        Emit-Prompt "blurred" $app $title $script:lastText
        $script:lastText = ""
        $script:lastKey = ""
      }
    }
  } catch {}
  Start-Sleep -Milliseconds 700
}
