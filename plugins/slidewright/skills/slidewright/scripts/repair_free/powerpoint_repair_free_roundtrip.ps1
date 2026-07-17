param(
  [Parameter(Mandatory = $true)][string]$FixtureId,
  [Parameter(Mandatory = $true)][string]$InputPptx,
  [Parameter(Mandatory = $true)][string]$OutputPptx,
  [Parameter(Mandatory = $true)][string]$ReportJson,
  [Parameter(Mandatory = $true)][string]$OwnershipRecordJson,
  [Parameter(Mandatory = $true)][string]$ArmedMarker,
  [Parameter(Mandatory = $true)][string]$StopMarker
)

$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'semantic_surface\presentation_path_identity.ps1')
$requestedInputPath = [IO.Path]::GetFullPath($InputPptx)
$requestedOutputPath = [IO.Path]::GetFullPath($OutputPptx)
$reportPath = [IO.Path]::GetFullPath($ReportJson)
$ownershipPath = [IO.Path]::GetFullPath($OwnershipRecordJson)
$armedPath = [IO.Path]::GetFullPath($ArmedMarker)
$stopPath = [IO.Path]::GetFullPath($StopMarker)
$localRoot = Join-Path ([IO.Path]::GetTempPath()) ("slidewright-c04-{0}-{1}" -f $PID, ($FixtureId -replace '[^A-Za-z0-9_-]', '-'))
$inputPath = Join-Path $localRoot 'source.pptx'
$outputPath = Join-Path $localRoot 'roundtrip.pptx'
$ownedPaths = @($inputPath, $outputPath)
New-Item -ItemType Directory -Force -Path $localRoot | Out-Null
Copy-Item -Force -LiteralPath $requestedInputPath -Destination $inputPath
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($requestedOutputPath)) | Out-Null
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($reportPath)) | Out-Null
if (Test-Path -LiteralPath $requestedOutputPath) { Remove-Item -Force -LiteralPath $requestedOutputPath }
if (Test-Path -LiteralPath $ownershipPath) { Remove-Item -Force -LiteralPath $ownershipPath }
if (Test-Path -LiteralPath $armedPath) { Remove-Item -Force -LiteralPath $armedPath }
if (Test-Path -LiteralPath $stopPath) { Remove-Item -Force -LiteralPath $stopPath }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SlidewrightRepairFreeNativeMethods {
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

function Round4($value) { return [Math]::Round([double]$value, 4) }

function Text-State($shape) {
  $range = $shape.TextFrame2.TextRange
  $runs = @()
  $runCollection = $range.Runs()
  for ($index = 1; $index -le [int]$runCollection.Count; $index++) {
    $run = $runCollection.Item($index)
    $style = [ordered]@{
      typeface = [string]$run.Font.Name
      size = Round4 $run.Font.Size
      bold = [int]$run.Font.Bold
      italic = [int]$run.Font.Italic
      underline = [int]$run.Font.UnderlineStyle
      color = $null
      language = $null
    }
    try { $style.color = [int]$run.Font.Fill.ForeColor.RGB } catch { }
    try { $style.language = [int]$run.LanguageID } catch { }
    $styleKey = $style | ConvertTo-Json -Depth 4 -Compress
    $text = [string]$run.Text
    if ($runs.Count -gt 0 -and [string]$runs[-1].styleKey -eq $styleKey) {
      $runs[-1].text = [string]$runs[-1].text + $text
    } else {
      $runs += [ordered]@{ text = $text; style = $style; styleKey = $styleKey }
    }
  }
  foreach ($run in $runs) { $run.Remove('styleKey') }
  $paragraphs = @()
  $paragraphCollection = $range.Paragraphs()
  for ($index = 1; $index -le [int]$paragraphCollection.Count; $index++) {
    $paragraph = $paragraphCollection.Item($index)
    $state = [ordered]@{
      text = [string]$paragraph.Text
      alignment = [int]$paragraph.ParagraphFormat.Alignment
      baselineAlignment = [int]$paragraph.ParagraphFormat.BaselineAlignment
      bulletVisible = [int]$paragraph.ParagraphFormat.Bullet.Visible
      bulletType = [int]$paragraph.ParagraphFormat.Bullet.Type
      bulletRelativeSize = Round4 $paragraph.ParagraphFormat.Bullet.RelativeSize
      firstLineIndent = Round4 $paragraph.ParagraphFormat.FirstLineIndent
      leftIndent = Round4 $paragraph.ParagraphFormat.LeftIndent
      rightIndent = Round4 $paragraph.ParagraphFormat.RightIndent
      spaceBefore = Round4 $paragraph.ParagraphFormat.SpaceBefore
      spaceAfter = Round4 $paragraph.ParagraphFormat.SpaceAfter
      spaceWithin = Round4 $paragraph.ParagraphFormat.SpaceWithin
    }
    $paragraphs += $state
  }
  return [ordered]@{
    value = [string]$range.Text
    runs = $runs
    paragraphs = $paragraphs
    frame = [ordered]@{
      marginLeft = Round4 $shape.TextFrame2.MarginLeft
      marginRight = Round4 $shape.TextFrame2.MarginRight
      marginTop = Round4 $shape.TextFrame2.MarginTop
      marginBottom = Round4 $shape.TextFrame2.MarginBottom
      autoSize = [int]$shape.TextFrame2.AutoSize
      wordWrap = [int]$shape.TextFrame2.WordWrap
      verticalAnchor = [int]$shape.TextFrame2.VerticalAnchor
    }
  }
}

function Shape-State($shape, [string]$path) {
  $state = [ordered]@{
    path = $path
    id = [int]$shape.Id
    name = [string]$shape.Name
    type = [int]$shape.Type
    left = Round4 $shape.Left
    top = Round4 $shape.Top
    width = Round4 $shape.Width
    height = Round4 $shape.Height
    rotation = Round4 $shape.Rotation
    zOrder = [int]$shape.ZOrderPosition
    text = $null
    groupItems = @()
    table = $null
    chart = $null
    connector = $null
    alternativeText = $null
    title = $null
    fill = $null
    line = $null
  }
  try { $state.alternativeText = [string]$shape.AlternativeText } catch { }
  try { $state.title = [string]$shape.Title } catch { }
  try {
    $state.fill = [ordered]@{ visible = [int]$shape.Fill.Visible; type = [int]$shape.Fill.Type; color = $null; transparency = Round4 $shape.Fill.Transparency }
    if ([int]$shape.Fill.Visible -eq -1) { $state.fill.color = [int]$shape.Fill.ForeColor.RGB }
  } catch { }
  try {
    $state.line = [ordered]@{ visible = [int]$shape.Line.Visible; color = $null; weight = Round4 $shape.Line.Weight; dashStyle = [int]$shape.Line.DashStyle; beginArrow = [int]$shape.Line.BeginArrowheadStyle; endArrow = [int]$shape.Line.EndArrowheadStyle }
    if ([int]$shape.Line.Visible -eq -1) { $state.line.color = [int]$shape.Line.ForeColor.RGB }
  } catch { }
  try {
    if ([int]$shape.HasTextFrame -eq -1 -and [int]$shape.TextFrame2.HasText -eq -1) {
      $state.text = Text-State $shape
    }
  } catch { }
  if ([int]$shape.Type -eq 6) {
    for ($index = 1; $index -le [int]$shape.GroupItems.Count; $index++) {
      $state.groupItems += Shape-State $shape.GroupItems.Item($index) "$path/$index"
    }
  }
  try {
    if ([int]$shape.HasTable -eq -1) {
      $rows = @()
      for ($row = 1; $row -le [int]$shape.Table.Rows.Count; $row++) {
        $cells = @()
        for ($column = 1; $column -le [int]$shape.Table.Columns.Count; $column++) {
          $cellShape = $shape.Table.Cell($row, $column).Shape
          $cells += Text-State $cellShape
        }
        $rows += ,@($cells)
      }
      $state.table = @($rows)
    }
  } catch { }
  try {
    if ([int]$shape.HasChart -eq -1) {
      $state.chart = [ordered]@{ chartType = [int]$shape.Chart.ChartType; seriesCount = [int]$shape.Chart.SeriesCollection().Count }
    }
  } catch { }
  try {
    if ([int]$shape.Connector -eq -1) {
      $state.connector = [ordered]@{
        beginConnected = [int]$shape.ConnectorFormat.BeginConnected
        endConnected = [int]$shape.ConnectorFormat.EndConnected
        beginShape = if ([int]$shape.ConnectorFormat.BeginConnected -eq -1) { [string]$shape.ConnectorFormat.BeginConnectedShape.Name } else { $null }
        endShape = if ([int]$shape.ConnectorFormat.EndConnected -eq -1) { [string]$shape.ConnectorFormat.EndConnectedShape.Name } else { $null }
      }
    }
  } catch { }
  return $state
}

function Presentation-State($presentation) {
  $slides = @()
  for ($slideIndex = 1; $slideIndex -le [int]$presentation.Slides.Count; $slideIndex++) {
    $slide = $presentation.Slides.Item($slideIndex)
    $shapes = @()
    for ($shapeIndex = 1; $shapeIndex -le [int]$slide.Shapes.Count; $shapeIndex++) {
      $shapes += Shape-State $slide.Shapes.Item($shapeIndex) "$slideIndex/$shapeIndex"
    }
    $notes = ''
    try { if ([int]$slide.HasNotesPage -eq -1) { $notes = [string]$slide.NotesPage.Shapes.Placeholders.Item(2).TextFrame2.TextRange.Text } } catch { }
    $layout = ''
    try { $layout = [string]$slide.CustomLayout.Name } catch { }
    $slides += [ordered]@{ index = $slideIndex; slideId = [int]$slide.SlideID; name = [string]$slide.Name; layout = $layout; notes = $notes; shapes = $shapes }
  }
  return [ordered]@{
    slideCount = [int]$presentation.Slides.Count
    slideWidth = Round4 $presentation.PageSetup.SlideWidth
    slideHeight = Round4 $presentation.PageSetup.SlideHeight
    designCount = [int]$presentation.Designs.Count
    slides = $slides
  }
}

function Close-OwnedPresentation($application, $presentation, [string]$context) {
  $allowed = @($ownedPaths | ForEach-Object { Get-NormalizedPresentationPath $_ })
  $captured = Get-NormalizedPresentationPath ([string]$presentation.FullName) $allowed
  if ([int]$application.Visible -ne 0 -or [int]$application.Presentations.Count -ne 1 -or -not ($allowed -contains $captured)) {
    throw "$context close refused because the hidden allowlisted presentation identity changed."
  }
  $presentation.Saved = -1
  $presentation.Close()
}

$existing = @((Get-Process POWERPNT -ErrorAction SilentlyContinue) | ForEach-Object { [int]$_.Id })
if ($existing.Count -gt 0) { throw 'C04 requires PowerPoint to be fully closed before each isolated fixture.' }
$application = $null
$presentation = $null
$ownedProcess = $null
$stage = 'initialize'
$primaryError = $null
try {
  $stage = 'create-powerpoint'
  $application = New-Object -ComObject PowerPoint.Application
  # Microsoft PowerPoint PpAlertLevel: ppAlertsAll = 2; ppAlertsNone = 1.
  $application.DisplayAlerts = 2
  Start-Sleep -Milliseconds 750
  [uint32]$resolvedPid = 0
  [void][SlidewrightRepairFreeNativeMethods]::GetWindowThreadProcessId([IntPtr]([long]$application.HWND), [ref]$resolvedPid)
  if ($resolvedPid -eq 0) { throw 'Could not resolve the PowerPoint automation process.' }
  $ownedProcess = Get-Process -Id ([int]$resolvedPid) -ErrorAction Stop
  if ($existing -contains [int]$resolvedPid) { throw 'PowerPoint automation attached to a pre-existing process.' }
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $resolvedPid" -ErrorAction Stop
  if ([string]$processInfo.CommandLine -notmatch '(?i)(?:^|\s)/AUTOMATION(?:\s|$)') { throw 'Resolved PowerPoint process is not an Office automation process.' }
  $executablePath = [IO.Path]::GetFullPath([string]$processInfo.ExecutablePath)
  $executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $executablePath).Hash.ToLowerInvariant()
  if ([int]$application.Visible -ne 0 -or [int]$application.Presentations.Count -ne 0) { throw 'New PowerPoint process is not empty and hidden.' }
  $ownership = [ordered]@{
    schemaVersion = 'slidewright-owned-powerpoint/v1'
    processName = 'POWERPNT'
    processId = [int]$resolvedPid
    processStartTime = $ownedProcess.StartTime.ToUniversalTime().ToString('o')
    workerProcessId = [int]$PID
    workerProcessName = [string](Get-Process -Id $PID -ErrorAction Stop).ProcessName
    workerProcessStartTime = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')
    purpose = "repair-free-$FixtureId"
    version = [string]$application.Version
    build = [string]$application.Build
    executableSha256 = $executableSha256
    expectedApplicationVisible = $false
    ownedPresentationPaths = $ownedPaths
  }
  $ownership | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 -LiteralPath $ownershipPath

  $stage = 'wait-for-exact-watcher-arm'
  $armDeadline = (Get-Date).AddSeconds(15)
  while (-not (Test-Path -LiteralPath $armedPath) -and (Get-Date) -lt $armDeadline) { Start-Sleep -Milliseconds 50 }
  if (-not (Test-Path -LiteralPath $armedPath)) { throw 'The exact PowerPoint watcher did not arm after ownership was published.' }
  $armedAt = (Get-Content -Raw -LiteralPath $armedPath).Trim()
  $parsedArmedAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse($armedAt, [ref]$parsedArmedAt)) { throw 'The exact PowerPoint watcher armed marker is invalid.' }

  $stage = 'open-source'
  $sourceOpenedAt = (Get-Date).ToUniversalTime().ToString('o')
  $presentation = $application.Presentations.Open($inputPath, $false, $false, $false)
  $before = Presentation-State $presentation
  $sourceHashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $requestedInputPath).Hash.ToLowerInvariant()
  $stage = 'saveas'
  $presentation.SaveAs($outputPath, 24)
  Close-OwnedPresentation $application $presentation 'C04 source'
  $presentation = $null
  $stage = 'reopen-roundtrip'
  $presentation = $application.Presentations.Open($outputPath, $true, $false, $false)
  $after = Presentation-State $presentation
  Close-OwnedPresentation $application $presentation 'C04 roundtrip'
  $presentation = $null
  $sourceHashAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath $requestedInputPath).Hash.ToLowerInvariant()
  $outputHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash.ToLowerInvariant()
  $beforeJson = $before | ConvertTo-Json -Depth 40 -Compress
  $afterJson = $after | ConvertTo-Json -Depth 40 -Compress
  $statePreserved = $beforeJson -eq $afterJson
  $valid = $statePreserved -and $sourceHashBefore -eq $sourceHashAfter -and $outputHash -ne $sourceHashBefore -and [int]$application.Visible -eq 0
  Copy-Item -Force -LiteralPath $outputPath -Destination $requestedOutputPath
  $result = [ordered]@{
    schemaVersion = 'slidewright-repair-free-powerpoint/v1'
    valid = $valid
    fixtureId = $FixtureId
    application = 'Microsoft PowerPoint'
    version = [string]$application.Version
    build = [string]$application.Build
    executableSha256 = $executableSha256
    processId = [int]$resolvedPid
    processStartTime = $ownedProcess.StartTime.ToUniversalTime().ToString('o')
    armedAt = $armedAt
    sourceOpenedAt = $sourceOpenedAt
    alertsEnabled = [int]$application.DisplayAlerts -eq 2
    hiddenThroughoutWorkerChecks = [int]$application.Visible -eq 0
    sourceUnchanged = $sourceHashBefore -eq $sourceHashAfter
    serializedToDistinctPackage = $outputHash -ne $sourceHashBefore
    exactLiveSemanticStatePreserved = $statePreserved
    sourceSha256 = $sourceHashBefore
    outputSha256 = $outputHash
    before = $before
    after = $after
  }
  $result | ConvertTo-Json -Depth 45 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
  if (-not $valid) { throw 'PowerPoint changed the live semantic state or source package.' }
} catch {
  $primaryError = "C04 fixture '$FixtureId' failed during '$stage': $($_.Exception.Message)"
} finally {
  if ($presentation) { try { Close-OwnedPresentation $application $presentation 'C04 failure cleanup' } catch { if (-not $primaryError) { $primaryError = $_.Exception.Message } } }
  if ($application) {
    try { if ([int]$application.Visible -ne 0) { throw 'PowerPoint became visible during C04 cleanup.' }; $application.Quit() } catch { if (-not $primaryError) { $primaryError = $_.Exception.Message } }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($application)
  }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  $ownedProcessExited = $true
  if ($ownedProcess) { $ownedProcessExited = $ownedProcess.WaitForExit(30000) }
  if (-not $ownedProcessExited -and -not $primaryError) { $primaryError = "Owned PowerPoint process did not exit after COM release for fixture '$FixtureId'." }
  if ($ownedProcessExited) {
    if (-not (Test-Path -LiteralPath $stopPath)) { New-Item -ItemType File -Path $stopPath | Out-Null }
    if (Test-Path -LiteralPath $localRoot) { Remove-Item -Recurse -Force -LiteralPath $localRoot }
  }
}
if ($primaryError) { throw $primaryError }
