param(
  [Parameter(Mandatory = $true)][string]$InputPptx,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [Parameter(Mandatory = $true)][string]$ReportJson,
  [string]$OwnershipRecordJson = '',
  [string]$WorkerIntentJson = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'presentation_path_identity.ps1')
$workerIntentPath = if ($WorkerIntentJson) { [IO.Path]::GetFullPath($WorkerIntentJson) } else { '' }
if ($workerIntentPath) {
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($workerIntentPath)) | Out-Null
  $workerProcess = Get-Process -Id $PID -ErrorAction Stop
  $intent = [ordered]@{
    schemaVersion = 'slidewright-worker-intent/v1'
    workerProcessId = [int]$PID
    workerProcessName = [string]$workerProcess.ProcessName
    workerProcessStartTime = $workerProcess.StartTime.ToUniversalTime().ToString('o')
    purpose = 'isolated-powerpoint-render'
    state = 'started'
    ownershipRecordPath = if ($OwnershipRecordJson) { [IO.Path]::GetFullPath($OwnershipRecordJson) } else { '' }
  }
  $intentTemporary = "$workerIntentPath.tmp-$PID"
  $intent | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $intentTemporary
  Move-Item -Force -LiteralPath $intentTemporary -Destination $workerIntentPath
}
$inputPath = [IO.Path]::GetFullPath($InputPptx)
$outputPath = [IO.Path]::GetFullPath($OutputDir)
$reportPath = [IO.Path]::GetFullPath($ReportJson)
$ownershipPath = if ($OwnershipRecordJson) { [IO.Path]::GetFullPath($OwnershipRecordJson) } else { '' }
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
if ($ownershipPath) {
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($ownershipPath)) | Out-Null
  if (Test-Path -LiteralPath $ownershipPath) { Remove-Item -Force -LiteralPath $ownershipPath }
}
Get-ChildItem -LiteralPath $outputPath -File -Filter 'slide-*.png' -ErrorAction SilentlyContinue | ForEach-Object {
  Remove-Item -Force -LiteralPath $_.FullName
}
Get-ChildItem -LiteralPath $outputPath -File -Filter 'slide-*.jpg' -ErrorAction SilentlyContinue | ForEach-Object {
  Remove-Item -Force -LiteralPath $_.FullName
}

function Retry([scriptblock]$Action, [int]$Attempts = 80) {
  $lastError = $null
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try { return & $Action } catch { $lastError = $_; Start-Sleep -Milliseconds 250 }
  }
  throw $lastError
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SlidewrightIsolatedRenderNativeMethods {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

function Write-OwnershipRecord($Process, [string]$Purpose, [string]$Version, [string]$Build, [string[]]$OwnedPresentationPaths) {
  if (-not $ownershipPath) { return }
  $record = [ordered]@{
    schemaVersion = 'slidewright-owned-powerpoint/v1'
    processName = 'POWERPNT'
    processId = [int]$Process.Id
    processStartTime = $Process.StartTime.ToUniversalTime().ToString('o')
    workerProcessId = [int]$PID
    workerProcessName = [string](Get-Process -Id $PID -ErrorAction Stop).ProcessName
    workerProcessStartTime = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')
    purpose = $Purpose
    version = $Version
    build = $Build
    expectedApplicationVisible = $false
    ownedPresentationPaths = @($OwnedPresentationPaths | ForEach-Object { [IO.Path]::GetFullPath($_) })
  }
  $temporary = "$ownershipPath.tmp"
  $record | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $temporary
  Move-Item -Force -LiteralPath $temporary -Destination $ownershipPath
}

function Test-EmptyPresentationInventory($Application) {
  $firstCount = [int]$Application.Presentations.Count
  $firstVisible = [int]$Application.Visible -ne 0
  Start-Sleep -Milliseconds 150
  $secondCount = [int]$Application.Presentations.Count
  $secondVisible = [int]$Application.Visible -ne 0
  return $firstCount -eq 0 -and $secondCount -eq 0 -and -not $firstVisible -and -not $secondVisible
}

function Close-CapturedOwnedPresentation($Application, $CapturedPresentation, [string[]]$OwnedPresentationPaths, [string]$Context) {
  if (-not $CapturedPresentation) { return }
  if (-not $Application) { throw "$Context close refused because the PowerPoint application reference is unavailable." }
  $allowedPaths = @($OwnedPresentationPaths | ForEach-Object { Get-NormalizedPresentationPath ([string]$_) } | Where-Object { $_ })
  $capturedPath = Get-NormalizedPresentationPath ([string]$CapturedPresentation.FullName) $allowedPaths
  if (-not $capturedPath -or -not ($allowedPaths -contains $capturedPath)) {
    throw "$Context close refused because the captured presentation path is not allowlisted."
  }
  for ($sample = 1; $sample -le 2; $sample++) {
    if ([int]$Application.Visible -ne 0) { throw "$Context close refused because the PowerPoint application became visible." }
    if ([int]$Application.Presentations.Count -ne 1) { throw "$Context close refused because the presentation inventory changed." }
    $inventoryPath = Get-NormalizedPresentationPath ([string]$Application.Presentations.Item(1).FullName) $allowedPaths
    $currentCapturedPath = Get-NormalizedPresentationPath ([string]$CapturedPresentation.FullName) $allowedPaths
    if ($inventoryPath -ne $capturedPath -or $currentCapturedPath -ne $capturedPath -or -not ($allowedPaths -contains $inventoryPath)) {
      throw "$Context close refused because the captured presentation identity changed."
    }
    if ($sample -eq 1) { Start-Sleep -Milliseconds 150 }
  }
  if ([int]$Application.Visible -ne 0 -or [int]$Application.Presentations.Count -ne 1) {
    throw "$Context close refused because PowerPoint state changed immediately before close."
  }
  $finalInventoryPath = Get-NormalizedPresentationPath ([string]$Application.Presentations.Item(1).FullName) $allowedPaths
  $finalCapturedPath = Get-NormalizedPresentationPath ([string]$CapturedPresentation.FullName) $allowedPaths
  if ($finalInventoryPath -ne $capturedPath -or $finalCapturedPath -ne $capturedPath -or -not ($allowedPaths -contains $finalInventoryPath)) {
    throw "$Context close refused because presentation identity changed immediately before close."
  }
  $CapturedPresentation.Close()
}

$ownedPaths = @($inputPath)

function Invoke-IsolatedPowerPoint([string]$Purpose, [scriptblock]$Action) {
  $existingIds = @((Get-Process POWERPNT -ErrorAction SilentlyContinue) | ForEach-Object { [int]$_.Id })
  if ($existingIds.Count -gt 0) {
    throw "Isolated render '$Purpose' requires PowerPoint to be fully closed before COM creation; refusing to attach to an existing user session."
  }
  $powerPoint = $null
  $ownedProcess = $null
  $ownedStart = $null
  $ownsProcess = $false
  $sharedProcess = $false
  $processId = 0
  $version = $null
  $build = $null
  try {
    $powerPoint = New-Object -ComObject PowerPoint.Application
    Start-Sleep -Milliseconds 750
    $version = [string]$powerPoint.Version
    try { $build = [string]$powerPoint.Build } catch { $build = $null }
    [uint32]$resolvedProcessId = 0
    [void][SlidewrightIsolatedRenderNativeMethods]::GetWindowThreadProcessId([IntPtr]([long]$powerPoint.HWND), [ref]$resolvedProcessId)
    $processId = [int]$resolvedProcessId
    if ($processId -eq 0) { throw 'Could not resolve the PowerPoint render process from its application window.' }
    $resolved = Get-Process -Id $processId -ErrorAction Stop
    if ($existingIds -contains $processId) {
      $sharedProcess = $true
      throw 'PowerPoint automation attached to a pre-existing process; isolated evidence requires a newly owned process.'
    }
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
    if ([string]$processInfo.CommandLine -notmatch '(?i)(?:^|\s)/AUTOMATION(?:\s|$)') {
      throw 'Resolved PowerPoint process is not an Office automation process; refusing ownership.'
    }
    if (-not (Test-EmptyPresentationInventory $powerPoint)) {
      throw 'Resolved PowerPoint process is not empty and hidden; refusing ownership.'
    }
    $ownsProcess = $true
    $ownedProcess = $resolved
    $ownedStart = $resolved.StartTime
    Write-OwnershipRecord $ownedProcess $Purpose $version $build $ownedPaths
    return & $Action $powerPoint
  } finally {
    $cleanupError = $null
    $script:sessions += [ordered]@{
      purpose = $Purpose
      processId = $processId
      processStartTime = if ($ownedStart) { $ownedStart.ToUniversalTime().ToString('o') } else { $null }
      automationProcessOwned = $ownsProcess
      attachedToPreExistingProcess = $sharedProcess
      version = $version
      build = $build
    }
    if ($powerPoint) {
      if ($ownsProcess) {
        if (-not (Test-EmptyPresentationInventory $powerPoint)) {
          $cleanupError = "Isolated render cleanup '$Purpose' refused because the owned automation process became visible or gained a presentation."
        }
      }
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    if ($ownsProcess -and -not $cleanupError) {
      $ownedExited = $ownedProcess.WaitForExit(45000)
      if (-not $ownedExited) { $cleanupError = "Owned PowerPoint process $($ownedProcess.Id) did not exit naturally after COM release." }
    }
    Start-Sleep -Milliseconds 250
    if ($cleanupError) { throw $cleanupError }
  }
}

$sessions = @()
$slideCount = Invoke-IsolatedPowerPoint 'slide-count' {
  param($powerPoint)
  $presentation = $null
  try {
    $presentation = Retry { $powerPoint.Presentations.Open($inputPath, $true, $false, $false) }
    return [int]$presentation.Slides.Count
  } finally {
    if ($presentation) { Close-CapturedOwnedPresentation $powerPoint $presentation $ownedPaths "Isolated render '$Purpose' slide-count presentation" }
  }
}

$renders = @()
for ($slideIndex = 1; $slideIndex -le $slideCount; $slideIndex++) {
  $file = Join-Path $outputPath ("slide-{0:D2}.png" -f $slideIndex)
  $reviewFile = Join-Path $outputPath ("slide-{0:D2}.jpg" -f $slideIndex)
  Invoke-IsolatedPowerPoint ("slide-{0:D2}" -f $slideIndex) {
    param($powerPoint)
    $presentation = $null
    try {
      $presentation = Retry { $powerPoint.Presentations.Open($inputPath, $true, $false, $false) }
      Retry { $presentation.Slides.Item($slideIndex).Export($file, 'PNG', 1600, 900) } | Out-Null
      Retry { $presentation.Slides.Item($slideIndex).Export($reviewFile, 'JPG', 1600, 900) } | Out-Null
    } finally {
      if ($presentation) { Close-CapturedOwnedPresentation $powerPoint $presentation $ownedPaths "Isolated render slide $slideIndex presentation" }
    }
  } | Out-Null
  if (-not (Test-Path -LiteralPath $file)) { throw "PowerPoint did not create $file" }
  if (-not (Test-Path -LiteralPath $reviewFile)) { throw "PowerPoint did not create $reviewFile" }
  $renders += [ordered]@{
    slide = $slideIndex
    file = [IO.Path]::GetFileName($file)
    width = 1600
    height = 900
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
    reviewFile = [IO.Path]::GetFileName($reviewFile)
    reviewSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $reviewFile).Hash.ToLowerInvariant()
  }
}

$allSessionsOwned = $sessions.Count -eq ($slideCount + 1) -and @($sessions | Where-Object { -not $_.automationProcessOwned }).Count -eq 0
$result = [ordered]@{
  valid = $renders.Count -eq $slideCount -and $slideCount -gt 0 -and $allSessionsOwned
  application = 'Microsoft PowerPoint'
  isolation = if ($allSessionsOwned) { 'newly owned PowerPoint process for slide count and every slide render' } else { 'not isolated' }
  allSessionsOwned = $allSessionsOwned
  sessions = $sessions
  inputSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $inputPath).Hash.ToLowerInvariant()
  slideCount = $slideCount
  renders = $renders
}
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($reportPath)) | Out-Null
$result | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
$result | ConvertTo-Json -Depth 10
if (-not $result.valid) { exit 1 }
