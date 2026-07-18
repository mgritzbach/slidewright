param(
  [Parameter(Mandatory = $true)][string]$InputPptx,
  [Parameter(Mandatory = $true)][string]$OutputPptx,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [Parameter(Mandatory = $true)][string]$ReportJson,
  [string]$TargetName = 'surface-01-body',
  [string]$ReplacementText = 'Native text edit verified in PowerPoint [C19].'
)

$ErrorActionPreference = 'Stop'
$inputPath = [IO.Path]::GetFullPath($InputPptx)
$outputPath = [IO.Path]::GetFullPath($OutputPptx)
$outputRoot = [IO.Path]::GetFullPath($OutputDir)
$reportPath = [IO.Path]::GetFullPath($ReportJson)
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($outputPath)) | Out-Null
if (Test-Path -LiteralPath $outputPath) { Remove-Item -Force -LiteralPath $outputPath }

function Text-Sha256([string]$Value) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  $hash = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  return ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
}

function Retry([scriptblock]$Action, [int]$Attempts = 80) {
  $last = $null
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try { return & $Action } catch { $last = $_; Start-Sleep -Milliseconds 250 }
  }
  throw $last
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SlidewrightC19NativeMethods {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

$existing = @((Get-Process POWERPNT -ErrorAction SilentlyContinue) | ForEach-Object { [int]$_.Id })
if ($existing.Count -gt 0) { throw 'C19 PowerPoint suite requires PowerPoint to be fully closed; refusing to attach to a user session.' }

$startedAt = [DateTimeOffset]::UtcNow
$powerPoint = $null
$presentation = $null
$reopened = $null
$ownedProcess = $null
$ownsProcess = $false
$beforeText = $null
$afterText = $null
$processId = 0
try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  Start-Sleep -Milliseconds 1000
  [uint32]$resolved = 0
  [void][SlidewrightC19NativeMethods]::GetWindowThreadProcessId([IntPtr]([long]$powerPoint.HWND), [ref]$resolved)
  $processId = [int]$resolved
  if ($processId -eq 0 -or $existing -contains $processId) { throw 'C19 could not bind a newly owned PowerPoint process.' }
  $ownedProcess = Get-Process -Id $processId -ErrorAction Stop
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
  if ([string]$processInfo.CommandLine -notmatch '(?i)(?:^|\s)/AUTOMATION(?:\s|$)') { throw 'C19 resolved PowerPoint process is not an Office automation process.' }
  if ([int]$powerPoint.Visible -ne 0 -or [int]$powerPoint.Presentations.Count -ne 0) { throw 'C19 owned PowerPoint process is not empty and hidden.' }
  $ownsProcess = $true

  $presentation = Retry { $powerPoint.Presentations.Open($inputPath, $false, $false, $false) }
  $target = $presentation.Slides.Item(1).Shapes.Item($TargetName)
  if ($target.HasTextFrame -ne -1 -or $target.TextFrame2.HasText -ne -1) { throw "C19 target '$TargetName' is not native editable text." }
  $beforeText = [string]$target.TextFrame2.TextRange.Text
  $replacement = $ReplacementText
  $target.TextFrame2.TextRange.Text = $replacement
  Retry { $presentation.SaveAs($outputPath, 24) } | Out-Null
  $presentation.Close(); $presentation = $null

  $reopened = Retry { $powerPoint.Presentations.Open($outputPath, $true, $false, $false) }
  $proof = $reopened.Slides.Item(1).Shapes.Item($TargetName)
  $afterText = [string]$proof.TextFrame2.TextRange.Text
  if ($afterText -ne $replacement) { throw 'C19 native sentinel text did not survive save and reopen.' }
  $slideCount = [int]$reopened.Slides.Count
  $reopened.Close(); $reopened = $null

  $renders = @()
  for ($slideIndex = 1; $slideIndex -le $slideCount; $slideIndex++) {
    $renderPresentation = $null
    $file = Join-Path $outputRoot ("slide-{0:D2}.png" -f $slideIndex)
    try {
      $renderPresentation = Retry { $powerPoint.Presentations.Open($outputPath, $true, $false, $false) }
      Retry { $renderPresentation.Slides.Item($slideIndex).Export($file, 'PNG', 1600, 900) } | Out-Null
    } finally {
      if ($renderPresentation) { $renderPresentation.Close() }
    }
    if (-not (Test-Path -LiteralPath $file)) { throw "C19 PowerPoint did not render slide $slideIndex." }
    $renders += [ordered]@{ slide = $slideIndex; file = [IO.Path]::GetFileName($file); width = 1600; height = 900; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() }
  }
  $endedAt = [DateTimeOffset]::UtcNow
  $result = [ordered]@{
    schemaVersion = 'slidewright-c19-powerpoint-windows-worker/v1'
    valid = $true
    startedAt = $startedAt.ToString('o')
    endedAt = $endedAt.ToString('o')
    application = 'Microsoft PowerPoint'
    version = [string]$powerPoint.Version
    build = [string]$powerPoint.Build
    platform = 'windows'
    processId = $processId
    processStartTime = $ownedProcess.StartTime.ToUniversalTime().ToString('o')
    processOwned = $ownsProcess
    executablePath = [string]$processInfo.ExecutablePath
    executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath ([string]$processInfo.ExecutablePath)).Hash.ToLowerInvariant()
    inputSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $inputPath).Hash.ToLowerInvariant()
    outputSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash.ToLowerInvariant()
    targetObjectId = $TargetName
    beforeTextSha256 = Text-Sha256 $beforeText
    afterTextSha256 = Text-Sha256 $afterText
    reopenedNativeTextMatched = $true
    slideCount = $slideCount
    renders = $renders
  }
  $result | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
  $result | ConvertTo-Json -Depth 12
} finally {
  if ($reopened) { try { $reopened.Close() } catch { } }
  if ($presentation) { try { $presentation.Close() } catch { } }
  foreach ($item in @($reopened, $presentation)) {
    if ($item -and [Runtime.InteropServices.Marshal]::IsComObject($item)) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($item) }
  }
  if ($powerPoint) {
    if ($ownsProcess -and ([int]$powerPoint.Visible -ne 0 -or [int]$powerPoint.Presentations.Count -ne 0)) { throw 'C19 cleanup refused because owned PowerPoint state changed.' }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
  }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  if ($ownsProcess -and -not $ownedProcess.WaitForExit(45000)) { throw "C19 owned PowerPoint process $processId did not exit naturally." }
}
