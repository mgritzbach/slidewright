param(
  [Parameter(Mandatory = $true)][string]$InputPptx,
  [Parameter(Mandatory = $true)][string]$OutputPptx,
  [Parameter(Mandatory = $true)][string]$ReportJson,
  [string]$OwnershipRecordJson = '',
  [string]$SourceRenderDir = '',
  [string]$RoundtripRenderDir = '',
  [string]$WorkerIntentJson = ''
)

$ErrorActionPreference = 'Stop'
$workerIntentPath = if ($WorkerIntentJson) { [IO.Path]::GetFullPath($WorkerIntentJson) } else { '' }
if ($workerIntentPath) {
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($workerIntentPath)) | Out-Null
  $workerProcess = Get-Process -Id $PID -ErrorAction Stop
  $intent = [ordered]@{
    schemaVersion = 'slidewright-worker-intent/v1'
    workerProcessId = [int]$PID
    workerProcessName = [string]$workerProcess.ProcessName
    workerProcessStartTime = $workerProcess.StartTime.ToUniversalTime().ToString('o')
    purpose = 'semantic-roundtrip'
    state = 'started'
    ownershipRecordPath = if ($OwnershipRecordJson) { [IO.Path]::GetFullPath($OwnershipRecordJson) } else { '' }
  }
  $intentTemporary = "$workerIntentPath.tmp-$PID"
  $intent | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $intentTemporary
  Move-Item -Force -LiteralPath $intentTemporary -Destination $workerIntentPath
}
$inputPath = [IO.Path]::GetFullPath($InputPptx)
$outputPath = [IO.Path]::GetFullPath($OutputPptx)
$reportPath = [IO.Path]::GetFullPath($ReportJson)
$ownershipPath = if ($OwnershipRecordJson) { [IO.Path]::GetFullPath($OwnershipRecordJson) } else { '' }
$sourceRenderPath = if ($SourceRenderDir) { [IO.Path]::GetFullPath($SourceRenderDir) } else { '' }
$roundtripRenderPath = if ($RoundtripRenderDir) { [IO.Path]::GetFullPath($RoundtripRenderDir) } else { '' }
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($outputPath)) | Out-Null
if (Test-Path -LiteralPath $outputPath) { Remove-Item -Force -LiteralPath $outputPath }
if ($ownershipPath) {
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($ownershipPath)) | Out-Null
  if (Test-Path -LiteralPath $ownershipPath) { Remove-Item -Force -LiteralPath $ownershipPath }
}

function Retry([scriptblock]$Action, [int]$Attempts = 80) {
  $lastError = $null
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try { return & $Action } catch { $lastError = $_; Start-Sleep -Milliseconds 250 }
  }
  throw $lastError
}

function Capture-State($presentation) {
  $slideStates = @()
  for ($slideIndex = 1; $slideIndex -le $presentation.Slides.Count; $slideIndex++) {
    $slide = $presentation.Slides.Item($slideIndex)
    $counts = [ordered]@{ shapes = 0; groups = 0; charts = 0; tables = 0; connectors = 0; pictures = 0; notesCharacters = 0 }
    for ($shapeIndex = 1; $shapeIndex -le $slide.Shapes.Count; $shapeIndex++) {
      $shape = $slide.Shapes.Item($shapeIndex)
      $counts.shapes++
      if ($shape.Type -eq 6) { $counts.groups++ }
      if ($shape.Type -eq 3) { $counts.charts++ }
      if ($shape.Type -eq 19) { $counts.tables++ }
      if ($shape.Connector -eq -1) { $counts.connectors++ }
      if ($shape.Type -eq 13) { $counts.pictures++ }
    }
    if ($slide.HasNotesPage -eq -1) {
      $notes = [string]$slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame.TextRange.Text
      $counts.notesCharacters = $notes.Trim().Length
    }
    $slideStates += [ordered]@{ index = $slideIndex; counts = $counts }
  }
  return [ordered]@{
    slideCount = [int]$presentation.Slides.Count
    slideWidth = [double]$presentation.PageSetup.SlideWidth
    slideHeight = [double]$presentation.PageSetup.SlideHeight
    slides = $slideStates
  }
}

function Export-Slides($powerPoint, [string]$presentationPath, [int]$slideCount, [string]$directory, [string[]]$OwnedPresentationPaths) {
  if (-not $directory) { return @() }
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  Get-ChildItem -LiteralPath $directory -File -Filter 'slide-*.png' -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item -Force -LiteralPath $_.FullName
  }
  $items = @()
  for ($slideIndex = 1; $slideIndex -le $slideCount; $slideIndex++) {
    $file = Join-Path $directory ("slide-{0:D2}.png" -f $slideIndex)
    if (Test-Path -LiteralPath $file) { Remove-Item -Force -LiteralPath $file }
    $renderPresentation = $null
    try {
      # A single PowerPoint presentation can leak chart/image render state from one
      # Slide.Export call into the next. Isolate every full-size evidence render.
      $renderPresentation = Retry { $powerPoint.Presentations.Open($presentationPath, $true, $false, $false) }
      Retry { $renderPresentation.Slides.Item($slideIndex).Export($file, 'PNG', 1600, 900) } | Out-Null
    } finally {
      if ($renderPresentation) { Close-CapturedOwnedPresentation $powerPoint $renderPresentation $OwnedPresentationPaths "Semantic round-trip slide $slideIndex render presentation" }
    }
    $items += [ordered]@{ slide = $slideIndex; file = [IO.Path]::GetFileName($file); sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() }
  }
  return $items
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SlidewrightSemanticNativeMethods {
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

function Get-NormalizedPresentationPath([string]$Value) {
  if (-not $Value) { return $null }
  try { return [IO.Path]::GetFullPath($Value) } catch { return $null }
}

function Close-CapturedOwnedPresentation($Application, $CapturedPresentation, [string[]]$OwnedPresentationPaths, [string]$Context) {
  if (-not $CapturedPresentation) { return }
  if (-not $Application) { throw "$Context close refused because the PowerPoint application reference is unavailable." }
  $allowedPaths = @($OwnedPresentationPaths | ForEach-Object { Get-NormalizedPresentationPath ([string]$_) } | Where-Object { $_ })
  $capturedPath = Get-NormalizedPresentationPath ([string]$CapturedPresentation.FullName)
  if (-not $capturedPath -or -not ($allowedPaths -contains $capturedPath)) {
    throw "$Context close refused because the captured presentation path is not allowlisted."
  }
  for ($sample = 1; $sample -le 2; $sample++) {
    if ([int]$Application.Visible -ne 0) { throw "$Context close refused because the PowerPoint application became visible." }
    if ([int]$Application.Presentations.Count -ne 1) { throw "$Context close refused because the presentation inventory changed." }
    $inventoryPath = Get-NormalizedPresentationPath ([string]$Application.Presentations.Item(1).FullName)
    $currentCapturedPath = Get-NormalizedPresentationPath ([string]$CapturedPresentation.FullName)
    if ($inventoryPath -ne $capturedPath -or $currentCapturedPath -ne $capturedPath -or -not ($allowedPaths -contains $inventoryPath)) {
      throw "$Context close refused because the captured presentation identity changed."
    }
    if ($sample -eq 1) { Start-Sleep -Milliseconds 150 }
  }
  if ([int]$Application.Visible -ne 0 -or [int]$Application.Presentations.Count -ne 1) {
    throw "$Context close refused because PowerPoint state changed immediately before close."
  }
  $finalInventoryPath = Get-NormalizedPresentationPath ([string]$Application.Presentations.Item(1).FullName)
  $finalCapturedPath = Get-NormalizedPresentationPath ([string]$CapturedPresentation.FullName)
  if ($finalInventoryPath -ne $capturedPath -or $finalCapturedPath -ne $capturedPath -or -not ($allowedPaths -contains $finalInventoryPath)) {
    throw "$Context close refused because presentation identity changed immediately before close."
  }
  $CapturedPresentation.Close()
}

$existingIds = @((Get-Process POWERPNT -ErrorAction SilentlyContinue).Id)
if ($existingIds.Count -gt 0) {
  throw 'Semantic round trip requires PowerPoint to be fully closed before COM creation; refusing to attach to an existing user session.'
}
$powerPoint = $null
$presentation = $null
$ownedProcess = $null
$ownedStart = $null
$sharedStart = $null
$ownsProcess = $false
$sharedProcess = $false
$powerPointVersion = $null
$powerPointBuild = $null
$ownedPaths = @($inputPath, $outputPath)
try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  if (-not $powerPoint) { throw 'PowerPoint COM application could not be created.' }
  $powerPointVersion = [string]$powerPoint.Version
  try { $powerPointBuild = [string]$powerPoint.Build } catch { $powerPointBuild = $null }
  Start-Sleep -Milliseconds 1000
  [uint32]$resolvedProcessId = 0
  [void][SlidewrightSemanticNativeMethods]::GetWindowThreadProcessId([IntPtr]([long]$powerPoint.HWND), [ref]$resolvedProcessId)
  $processId = [int]$resolvedProcessId
  if ($processId -eq 0) { throw 'Could not resolve the PowerPoint COM process from its application window.' }
  $resolved = Get-Process -Id $processId -ErrorAction Stop
  if ($existingIds -contains [int]$processId) {
    $sharedProcess = $true
    $sharedStart = $resolved.StartTime
    throw 'PowerPoint automation attached to a pre-existing process; semantic round-trip evidence requires a newly owned process.'
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
  Write-OwnershipRecord $ownedProcess 'semantic-roundtrip' $powerPointVersion $powerPointBuild $ownedPaths

  $presentation = Retry { $powerPoint.Presentations.Open($inputPath, $false, $false, $false) }
  $before = Retry { Capture-State $presentation }
  Close-CapturedOwnedPresentation $powerPoint $presentation $ownedPaths 'Semantic round-trip source inspection presentation'
  $presentation = $null
  $sourceRenders = Export-Slides $powerPoint $inputPath $before.slideCount $sourceRenderPath $ownedPaths
  # PowerPoint can invalidate a presentation COM handle after repeated Slide.Export calls.
  # Reopen from disk before SaveAs so rendering and serialization use independent handles.
  $presentation = Retry { $powerPoint.Presentations.Open($inputPath, $false, $false, $false) }
  $beforeSave = Retry { Capture-State $presentation }
  $sourceRenderStatePreserved = ($before | ConvertTo-Json -Depth 20 -Compress) -eq ($beforeSave | ConvertTo-Json -Depth 20 -Compress)
  Retry { $presentation.SaveAs($outputPath, 24) } | Out-Null
  Close-CapturedOwnedPresentation $powerPoint $presentation $ownedPaths 'Semantic round-trip source SaveAs presentation'
  $presentation = $null
  $presentation = Retry { $powerPoint.Presentations.Open($outputPath, $true, $false, $false) }
  $after = Retry { Capture-State $presentation }
  Close-CapturedOwnedPresentation $powerPoint $presentation $ownedPaths 'Semantic round-trip reopened output presentation'
  $presentation = $null
  $roundtripRenders = Export-Slides $powerPoint $outputPath $after.slideCount $roundtripRenderPath $ownedPaths

  $serialized = (Get-FileHash -Algorithm SHA256 -LiteralPath $inputPath).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash
  $statePreserved = $sourceRenderStatePreserved -and (($beforeSave | ConvertTo-Json -Depth 20 -Compress) -eq ($after | ConvertTo-Json -Depth 20 -Compress))
  $sharedPreserved = $true
  if ($sharedProcess) {
    $sharedAfter = Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue
    $sharedPreserved = $null -ne $sharedAfter -and $sharedAfter.StartTime -eq $sharedStart
  }
  $valid = $serialized -and $statePreserved -and $ownsProcess -and $sharedPreserved -and $after.slideCount -eq 4
  $result = [ordered]@{
    valid = $valid
    application = 'Microsoft PowerPoint'
    serializedBySaveAs = $serialized
    sourceRenderStatePreserved = $sourceRenderStatePreserved
    exactTopLevelStatePreserved = $statePreserved
    automationProcessOwned = $ownsProcess
    processId = [int]$processId
    processStartTime = $ownedStart.ToUniversalTime().ToString('o')
    version = $powerPointVersion
    build = $powerPointBuild
    sharedProcessPreserved = $sharedPreserved
    inputSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $inputPath).Hash.ToLowerInvariant()
    outputSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash.ToLowerInvariant()
    sourceRenders = $sourceRenders
    roundtripRenders = $roundtripRenders
    beforeSave = $before
    afterReopen = $after
  }
  $result | ConvertTo-Json -Depth 25 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
  $result | ConvertTo-Json -Depth 8
  if (-not $valid) { exit 1 }
} finally {
  $cleanupError = $null
  if ($presentation) {
    try { Close-CapturedOwnedPresentation $powerPoint $presentation $ownedPaths 'Semantic round-trip final cleanup' } catch { $cleanupError = $_.Exception.Message }
    $presentation = $null
  }
  if ($powerPoint) {
    if (-not $cleanupError -and $ownsProcess) {
      if (-not (Test-EmptyPresentationInventory $powerPoint)) {
        $cleanupError = 'Semantic round-trip cleanup refused because the owned automation process became visible or gained a presentation.'
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
  if ($cleanupError) { throw $cleanupError }
}
