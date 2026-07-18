param(
  [Parameter(Mandatory = $true)][string]$InputPptx,
  [Parameter(Mandatory = $true)][string]$OutputPptx,
  [Parameter(Mandatory = $true)][string]$ReportJson,
  [string]$OwnershipRecordJson = '',
  [string]$FixtureId = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'semantic_surface\presentation_path_identity.ps1')

$inputPath = [IO.Path]::GetFullPath($InputPptx)
$outputPath = [IO.Path]::GetFullPath($OutputPptx)
$reportPath = [IO.Path]::GetFullPath($ReportJson)
$ownershipPath = if ($OwnershipRecordJson) { [IO.Path]::GetFullPath($OwnershipRecordJson) } else { '' }

if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) { throw "Input presentation does not exist: $inputPath" }
if ([IO.Path]::GetExtension($inputPath) -ne '.pptx') { throw 'C10 PowerPoint round-trip input must be a .pptx file.' }
if ([IO.Path]::GetExtension($outputPath) -ne '.pptx') { throw 'C10 PowerPoint round-trip output must be a .pptx file.' }
if ($inputPath.Equals($outputPath, [StringComparison]::OrdinalIgnoreCase)) { throw 'C10 PowerPoint round-trip output must be distinct from its input.' }
if ($reportPath.Equals($inputPath, [StringComparison]::OrdinalIgnoreCase) -or $reportPath.Equals($outputPath, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The C10 report path must be distinct from the input and output presentations.'
}
if ($ownershipPath -and (
  $ownershipPath.Equals($inputPath, [StringComparison]::OrdinalIgnoreCase) -or
  $ownershipPath.Equals($outputPath, [StringComparison]::OrdinalIgnoreCase) -or
  $ownershipPath.Equals($reportPath, [StringComparison]::OrdinalIgnoreCase)
)) { throw 'The C10 ownership-record path must be distinct from every other artifact path.' }

# Refuse before deleting or creating artifacts. A COM activation can otherwise attach to a
# user's existing PowerPoint session, and no C10 evidence is worth that risk.
$preexistingPowerPoint = @((Get-Process POWERPNT -ErrorAction SilentlyContinue) | ForEach-Object {
  [ordered]@{ processId = [int]$_.Id; startTime = $_.StartTime.ToUniversalTime().ToString('o') }
})
if ($preexistingPowerPoint.Count -gt 0) {
  throw 'C10 template round-trip requires PowerPoint to be fully closed; refusing to attach to or modify a pre-existing user session.'
}

New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($outputPath)) | Out-Null
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($reportPath)) | Out-Null
if ($ownershipPath) { New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($ownershipPath)) | Out-Null }
if (Test-Path -LiteralPath $outputPath) { Remove-Item -Force -LiteralPath $outputPath }
if (Test-Path -LiteralPath $reportPath) { Remove-Item -Force -LiteralPath $reportPath }
if ($ownershipPath -and (Test-Path -LiteralPath $ownershipPath)) { Remove-Item -Force -LiteralPath $ownershipPath }

$ownedPresentationPaths = @($inputPath, $outputPath)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SlidewrightTemplateMatrixNativeMethods {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

function Round4($Value) {
  if ($null -eq $Value) { return $null }
  return [Math]::Round([double]$Value, 4)
}

function Retry([scriptblock]$Action, [int]$Attempts = 80) {
  $lastError = $null
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try { return & $Action } catch { $lastError = $_; Start-Sleep -Milliseconds 250 }
  }
  throw $lastError
}

function Get-OptionalValue([scriptblock]$Action) {
  try { return & $Action } catch { return $null }
}

function Capture-TextState($Shape) {
  $frame = $Shape.TextFrame2
  $range = $frame.TextRange
  $runs = @()
  $runCollection = $range.Runs()
  for ($index = 1; $index -le [int]$runCollection.Count; $index++) {
    $run = $runCollection.Item($index)
    $runs += [ordered]@{
      index = $index
      text = [string]$run.Text
      typeface = [string](Get-OptionalValue { $run.Font.Name })
      size = Round4 (Get-OptionalValue { $run.Font.Size })
      bold = Get-OptionalValue { [int]$run.Font.Bold }
      italic = Get-OptionalValue { [int]$run.Font.Italic }
      underline = Get-OptionalValue { [int]$run.Font.UnderlineStyle }
      languageId = Get-OptionalValue { [int]$run.LanguageID }
      fontColorRgb = Get-OptionalValue { [int]$run.Font.Fill.ForeColor.RGB }
    }
  }

  $paragraphs = @()
  $paragraphCollection = $range.Paragraphs()
  for ($index = 1; $index -le [int]$paragraphCollection.Count; $index++) {
    $paragraph = $paragraphCollection.Item($index)
    $format = $paragraph.ParagraphFormat
    $paragraphs += [ordered]@{
      index = $index
      text = [string]$paragraph.Text
      alignment = Get-OptionalValue { [int]$format.Alignment }
      baselineAlignment = Get-OptionalValue { [int]$format.BaselineAlignment }
      firstLineIndent = Round4 (Get-OptionalValue { $format.FirstLineIndent })
      leftIndent = Round4 (Get-OptionalValue { $format.LeftIndent })
      rightIndent = Round4 (Get-OptionalValue { $format.RightIndent })
      spaceBefore = Round4 (Get-OptionalValue { $format.SpaceBefore })
      spaceAfter = Round4 (Get-OptionalValue { $format.SpaceAfter })
      spaceWithin = Round4 (Get-OptionalValue { $format.SpaceWithin })
      lineRuleBefore = Get-OptionalValue { [int]$format.LineRuleBefore }
      lineRuleAfter = Get-OptionalValue { [int]$format.LineRuleAfter }
      lineRuleWithin = Get-OptionalValue { [int]$format.LineRuleWithin }
      bullet = [ordered]@{
        visible = Get-OptionalValue { [int]$format.Bullet.Visible }
        type = Get-OptionalValue { [int]$format.Bullet.Type }
        character = Get-OptionalValue { [int]$format.Bullet.Character }
        relativeSize = Round4 (Get-OptionalValue { $format.Bullet.RelativeSize })
        startValue = Get-OptionalValue { [int]$format.Bullet.StartValue }
        style = Get-OptionalValue { [int]$format.Bullet.Style }
      }
    }
  }

  return [ordered]@{
    value = [string]$range.Text
    hasText = Get-OptionalValue { [int]$frame.HasText }
    frame = [ordered]@{
      marginLeft = Round4 $frame.MarginLeft
      marginRight = Round4 $frame.MarginRight
      marginTop = Round4 $frame.MarginTop
      marginBottom = Round4 $frame.MarginBottom
      autoSize = Get-OptionalValue { [int]$frame.AutoSize }
      wordWrap = Get-OptionalValue { [int]$frame.WordWrap }
      verticalAnchor = Get-OptionalValue { [int]$frame.VerticalAnchor }
      orientation = Get-OptionalValue { [int]$frame.Orientation }
    }
    paragraphs = $paragraphs
    runs = $runs
  }
}

function Capture-ShapeState($Shape, [string]$Path) {
  $state = [ordered]@{
    path = $Path
    id = [int]$Shape.Id
    name = [string]$Shape.Name
    type = [int]$Shape.Type
    left = Round4 $Shape.Left
    top = Round4 $Shape.Top
    width = Round4 $Shape.Width
    height = Round4 $Shape.Height
    rotation = Round4 $Shape.Rotation
    zOrderPosition = Get-OptionalValue { [int]$Shape.ZOrderPosition }
    alternativeText = Get-OptionalValue { [string]$Shape.AlternativeText }
    title = Get-OptionalValue { [string]$Shape.Title }
    placeholder = $null
    text = $null
    groupItems = @()
    table = $null
    chart = $null
    connector = $null
    fill = $null
    line = $null
  }

  if ([int]$Shape.Type -eq 14) {
    $state.placeholder = [ordered]@{
      type = Get-OptionalValue { [int]$Shape.PlaceholderFormat.Type }
      containedType = Get-OptionalValue { [int]$Shape.PlaceholderFormat.ContainedType }
      index = Get-OptionalValue { [int]$Shape.PlaceholderFormat.Index }
    }
  }

  if ([int]$Shape.HasTextFrame -eq -1) {
    $state.text = Capture-TextState $Shape
  }

  if ([int]$Shape.Type -eq 6) {
    for ($index = 1; $index -le [int]$Shape.GroupItems.Count; $index++) {
      $state.groupItems += Capture-ShapeState $Shape.GroupItems.Item($index) "$Path/group[$index]"
    }
  }

  # As with charts, do not retain nested Table/Cell/Shape RCWs before asking Office
  # to serialize and exit. Native table presence is captured live; table structure,
  # cells, margins, and rendered appearance are checked outside COM.
  if ([int]$Shape.HasTable -eq -1) {
    $state.table = [ordered]@{ present = $true }
  }

  # Do not activate the embedded chart workbook before serialization. Several valid
  # template decks terminate PowerPoint during SaveAs/SaveCopyAs after Chart or
  # SeriesCollection has been automated. HasChart is a native shape property and is
  # sufficient here; chart XML/workbook bytes and rendered appearance are audited by
  # the surrounding C10 package and visual gates.
  if ([int]$Shape.HasChart -eq -1) {
    $state.chart = [ordered]@{ present = $true }
  }

  if ([int]$Shape.Connector -eq -1) {
    $state.connector = [ordered]@{
      beginConnected = Get-OptionalValue { [int]$Shape.ConnectorFormat.BeginConnected }
      endConnected = Get-OptionalValue { [int]$Shape.ConnectorFormat.EndConnected }
      beginShapeName = Get-OptionalValue { [string]$Shape.ConnectorFormat.BeginConnectedShape.Name }
      endShapeName = Get-OptionalValue { [string]$Shape.ConnectorFormat.EndConnectedShape.Name }
    }
  }

  $state.fill = [ordered]@{
    visible = Get-OptionalValue { [int]$Shape.Fill.Visible }
    type = Get-OptionalValue { [int]$Shape.Fill.Type }
    colorRgb = Get-OptionalValue { [int]$Shape.Fill.ForeColor.RGB }
    transparency = Round4 (Get-OptionalValue { $Shape.Fill.Transparency })
  }
  $state.line = [ordered]@{
    visible = Get-OptionalValue { [int]$Shape.Line.Visible }
    colorRgb = Get-OptionalValue { [int]$Shape.Line.ForeColor.RGB }
    weight = Round4 (Get-OptionalValue { $Shape.Line.Weight })
    dashStyle = Get-OptionalValue { [int]$Shape.Line.DashStyle }
    beginArrowhead = Get-OptionalValue { [int]$Shape.Line.BeginArrowheadStyle }
    endArrowhead = Get-OptionalValue { [int]$Shape.Line.EndArrowheadStyle }
  }
  return $state
}

function Capture-ShapeCollection($Shapes, [string]$PathPrefix) {
  $items = @()
  for ($index = 1; $index -le [int]$Shapes.Count; $index++) {
    $items += Capture-ShapeState $Shapes.Item($index) "$PathPrefix/shape[$index]"
  }
  return $items
}

function Capture-HeadersFooters($Owner) {
  return [ordered]@{
    dateAndTimeVisible = Get-OptionalValue { [int]$Owner.HeadersFooters.DateAndTime.Visible }
    dateAndTimeText = Get-OptionalValue { [string]$Owner.HeadersFooters.DateAndTime.Text }
    footerVisible = Get-OptionalValue { [int]$Owner.HeadersFooters.Footer.Visible }
    footerText = Get-OptionalValue { [string]$Owner.HeadersFooters.Footer.Text }
    slideNumberVisible = Get-OptionalValue { [int]$Owner.HeadersFooters.SlideNumber.Visible }
  }
}

function Capture-PresentationState($Presentation) {
  $guides = @()
  for ($guideIndex = 1; $guideIndex -le [int]$Presentation.Guides.Count; $guideIndex++) {
    $guide = $Presentation.Guides.Item($guideIndex)
    $guides += [ordered]@{
      index = $guideIndex
      orientation = [int]$guide.Orientation
      position = Round4 $guide.Position
    }
  }

  $designs = @()
  for ($designIndex = 1; $designIndex -le [int]$Presentation.Designs.Count; $designIndex++) {
    $design = $Presentation.Designs.Item($designIndex)
    $master = $design.SlideMaster
    $layouts = @()
    for ($layoutIndex = 1; $layoutIndex -le [int]$master.CustomLayouts.Count; $layoutIndex++) {
      $layout = $master.CustomLayouts.Item($layoutIndex)
      $layouts += [ordered]@{
        index = $layoutIndex
        name = [string]$layout.Name
        matchingName = Get-OptionalValue { [string]$layout.MatchingName }
        preserve = Get-OptionalValue { [int]$layout.Preserve }
        headersFooters = Capture-HeadersFooters $layout
        shapes = Capture-ShapeCollection $layout.Shapes "design[$designIndex]/layout[$layoutIndex]"
      }
    }
    $designs += [ordered]@{
      index = $designIndex
      name = [string]$design.Name
      master = [ordered]@{
        name = [string]$master.Name
        preserve = Get-OptionalValue { [int]$master.Preserve }
        headersFooters = Capture-HeadersFooters $master
        shapes = Capture-ShapeCollection $master.Shapes "design[$designIndex]/master"
      }
      layouts = $layouts
    }
  }

  $slides = @()
  for ($slideIndex = 1; $slideIndex -le [int]$Presentation.Slides.Count; $slideIndex++) {
    $slide = $Presentation.Slides.Item($slideIndex)
    $slides += [ordered]@{
      index = $slideIndex
      slideId = [int]$slide.SlideID
      name = [string]$slide.Name
      designName = Get-OptionalValue { [string]$slide.Design.Name }
      masterName = Get-OptionalValue { [string]$slide.Master.Name }
      layoutName = Get-OptionalValue { [string]$slide.CustomLayout.Name }
      layoutIndex = Get-OptionalValue { [int]$slide.CustomLayout.Index }
      followMasterBackground = Get-OptionalValue { [int]$slide.FollowMasterBackground }
      headersFooters = Capture-HeadersFooters $slide
      shapes = Capture-ShapeCollection $slide.Shapes "slide[$slideIndex]"
    }
  }

  return [ordered]@{
    slideCount = [int]$Presentation.Slides.Count
    slideWidth = Round4 $Presentation.PageSetup.SlideWidth
    slideHeight = Round4 $Presentation.PageSetup.SlideHeight
    designCount = [int]$Presentation.Designs.Count
    guides = $guides
    designs = $designs
    slides = $slides
  }
}

function Test-EmptyHiddenApplication($Application) {
  for ($sample = 1; $sample -le 2; $sample++) {
    if ([int]$Application.Visible -ne 0 -or [int]$Application.Presentations.Count -ne 0) { return $false }
    if ($sample -eq 1) { Start-Sleep -Milliseconds 150 }
  }
  return $true
}

function Close-CapturedOwnedPresentation($Application, $CapturedPresentation, [string]$Context) {
  if (-not $CapturedPresentation) { return }
  if (-not $Application) { throw "$Context close refused because the PowerPoint application reference is unavailable." }
  $allowlist = @($ownedPresentationPaths | ForEach-Object { Get-NormalizedPresentationPath ([string]$_) } | Where-Object { $_ })
  if ($allowlist.Count -ne 2) { throw "$Context close refused because the input/output allowlist is incomplete." }
  $capturedPath = Get-NormalizedPresentationPath ([string]$CapturedPresentation.FullName) $allowlist
  if (-not $capturedPath -or -not ($allowlist -contains $capturedPath)) {
    throw "$Context close refused because the captured presentation is not the allowlisted input or output."
  }
  for ($sample = 1; $sample -le 2; $sample++) {
    if ([int]$Application.Visible -ne 0) { throw "$Context close refused because PowerPoint became visible." }
    if ([int]$Application.Presentations.Count -ne 1) { throw "$Context close refused because the presentation inventory changed." }
    $inventoryPath = Get-NormalizedPresentationPath ([string]$Application.Presentations.Item(1).FullName) $allowlist
    $currentPath = Get-NormalizedPresentationPath ([string]$CapturedPresentation.FullName) $allowlist
    if ($inventoryPath -ne $capturedPath -or $currentPath -ne $capturedPath) {
      throw "$Context close refused because presentation identity changed."
    }
    if ($sample -eq 1) { Start-Sleep -Milliseconds 150 }
  }
  $CapturedPresentation.Saved = -1
  $CapturedPresentation.Close()
}

function Write-JsonAtomically([object]$Value, [string]$Path, [int]$Depth = 60) {
  $temporaryPath = "$Path.tmp-$PID"
  $Value | ConvertTo-Json -Depth $Depth | Set-Content -Encoding UTF8 -LiteralPath $temporaryPath
  Move-Item -Force -LiteralPath $temporaryPath -Destination $Path
}

$application = $null
$presentation = $null
$ownedProcess = $null
$ownsProcess = $false
$ownership = $null
$result = $null
$stage = 'initialize'
$primaryError = $null
$cleanupError = $null
$inputHashBefore = (Get-FileHash -Algorithm SHA256 -LiteralPath $inputPath).Hash.ToLowerInvariant()
$comActivationStartedAt = $null

try {
  $stage = 'create-powerpoint'
  $comActivationStartedAt = (Get-Date).ToUniversalTime()
  try { $registeredType = [Type]::GetTypeFromProgID('PowerPoint.Application') } catch { $registeredType = $null }
  if (-not $registeredType) { throw 'Microsoft PowerPoint is required but PowerPoint.Application is not registered.' }
  $application = New-Object -ComObject PowerPoint.Application
  if (-not $application) { throw 'Microsoft PowerPoint is required but its COM application could not be created.' }
  Start-Sleep -Milliseconds 1000

  [uint32]$resolvedProcessId = 0
  [void][SlidewrightTemplateMatrixNativeMethods]::GetWindowThreadProcessId([IntPtr]([long]$application.HWND), [ref]$resolvedProcessId)
  if ($resolvedProcessId -eq 0) { throw 'Could not resolve the PowerPoint COM application to a process.' }
  $ownedProcess = Get-Process -Id ([int]$resolvedProcessId) -ErrorAction Stop
  $powerPointProcesses = @((Get-Process POWERPNT -ErrorAction Stop) | ForEach-Object { [int]$_.Id })
  if ($powerPointProcesses.Count -ne 1 -or $powerPointProcesses[0] -ne [int]$resolvedProcessId) {
    throw 'PowerPoint process inventory is not the single newly resolved automation process; refusing ownership.'
  }
  if ($ownedProcess.StartTime.ToUniversalTime() -lt $comActivationStartedAt.AddSeconds(-2)) {
    throw 'Resolved PowerPoint process predates this COM activation; refusing ownership.'
  }
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $resolvedProcessId" -ErrorAction Stop
  if ([string]$processInfo.Name -notmatch '^(?i:POWERPNT\.EXE)$') { throw 'Resolved COM process is not POWERPNT.EXE.' }
  if ([string]$processInfo.CommandLine -notmatch '(?i)(?:^|\s)/AUTOMATION(?:\s|$)') {
    throw 'Resolved PowerPoint process is not an Office /AUTOMATION process; refusing ownership.'
  }
  if (-not (Test-EmptyHiddenApplication $application)) {
    throw 'Resolved PowerPoint /AUTOMATION process is not empty and hidden; refusing ownership.'
  }
  $executablePath = [IO.Path]::GetFullPath([string]$processInfo.ExecutablePath)
  $ownsProcess = $true
  $ownership = [ordered]@{
    schemaVersion = 'slidewright-owned-powerpoint/v1'
    purpose = 'template-matrix-roundtrip'
    fixtureId = $FixtureId
    processName = 'POWERPNT'
    processId = [int]$resolvedProcessId
    processStartTime = $ownedProcess.StartTime.ToUniversalTime().ToString('o')
    parentProcessId = [int]$processInfo.ParentProcessId
    commandLineHasAutomationSwitch = $true
    workerProcessId = [int]$PID
    workerProcessName = [string](Get-Process -Id $PID -ErrorAction Stop).ProcessName
    workerProcessStartTime = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')
    version = [string]$application.Version
    build = Get-OptionalValue { [string]$application.Build }
    executablePath = $executablePath
    executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $executablePath).Hash.ToLowerInvariant()
    expectedApplicationVisible = $false
    preexistingPowerPointProcessCount = 0
    ownedPresentationPaths = @($ownedPresentationPaths)
  }
  if ($ownershipPath) { Write-JsonAtomically $ownership $ownershipPath 8 }

  $stage = 'open-input'
  $presentation = Retry { $application.Presentations.Open($inputPath, $false, $false, $false) }
  $before = Retry { Capture-PresentationState $presentation }

  $stage = 'save-as-output'
  # SaveCopyAs invokes PowerPoint's native serializer without retargeting the live
  # presentation. This avoids mutating the opened source session and is reliable for
  # templates that contain embedded workbooks where SaveAs can terminate Office.
  Retry { $presentation.SaveCopyAs($outputPath, 24) } | Out-Null
  Close-CapturedOwnedPresentation $application $presentation 'C10 input SaveCopyAs presentation'
  $presentation = $null

  $stage = 'reopen-output'
  $presentation = Retry { $application.Presentations.Open($outputPath, $true, $false, $false) }
  $after = Retry { Capture-PresentationState $presentation }
  Close-CapturedOwnedPresentation $application $presentation 'C10 reopened output presentation'
  $presentation = $null

  $stage = 'compare'
  $inputHashAfter = (Get-FileHash -Algorithm SHA256 -LiteralPath $inputPath).Hash.ToLowerInvariant()
  $outputHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash.ToLowerInvariant()
  $beforeJson = $before | ConvertTo-Json -Depth 60 -Compress
  $afterJson = $after | ConvertTo-Json -Depth 60 -Compress
  $semanticStatePreserved = $beforeJson -ceq $afterJson
  $sourceUnchanged = $inputHashBefore -eq $inputHashAfter
  $serializedToDistinctPackage = $outputHash -ne $inputHashBefore
  $hiddenAndEmptyAfterClose = Test-EmptyHiddenApplication $application
  $validBeforeCleanup = $ownsProcess -and $semanticStatePreserved -and $sourceUnchanged -and $serializedToDistinctPackage -and $hiddenAndEmptyAfterClose
  $result = [ordered]@{
    schemaVersion = 'slidewright-template-matrix-powerpoint/v1'
    valid = $validBeforeCleanup
    fixtureId = $FixtureId
    application = 'Microsoft PowerPoint'
    version = [string]$application.Version
    build = Get-OptionalValue { [string]$application.Build }
    ownership = $ownership
    automationProcessOwned = $ownsProcess
    hiddenAndEmptyAfterClose = $hiddenAndEmptyAfterClose
    sourceUnchanged = $sourceUnchanged
    serializedToDistinctPackage = $serializedToDistinctPackage
    exactLiveSemanticStatePreserved = $semanticStatePreserved
    dynamicSlideCount = [int]$before.slideCount
    inputSha256 = $inputHashBefore
    inputSha256After = $inputHashAfter
    outputSha256 = $outputHash
    beforeSave = $before
    afterReopen = $after
  }
  if (-not $validBeforeCleanup) { $primaryError = 'PowerPoint changed the source, package serialization, visibility, or captured live semantic state.' }
} catch {
  $primaryError = "C10 PowerPoint round-trip failed during stage '$stage': $($_.Exception.Message)"
} finally {
  if ($presentation) {
    try { Close-CapturedOwnedPresentation $application $presentation "C10 failure cleanup after stage '$stage'" }
    catch { $cleanupError = $_.Exception.Message }
    $presentation = $null
  }
  if ($application) {
    if (-not $cleanupError -and $ownsProcess -and -not (Test-EmptyHiddenApplication $application)) {
      $cleanupError = 'C10 cleanup refused because the owned PowerPoint process became visible or gained a presentation.'
    }
    # Deliberately do not call Application.Quit and never force-stop POWERPNT. Releasing the
    # last RCW is allowed only after proving this is our hidden, empty /AUTOMATION process.
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($application)
    $application = $null
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  $ownedProcessExitedNaturally = $false
  if ($ownsProcess -and $ownedProcess) {
    $ownedProcessExitedNaturally = $ownedProcess.WaitForExit(45000)
    if (-not $ownedProcessExitedNaturally -and -not $cleanupError) {
      $cleanupError = "Owned PowerPoint /AUTOMATION process $($ownedProcess.Id) did not exit naturally after COM release; it was not terminated."
    }
  }
}

if (-not $result) {
  $inputHashAfterFailure = if (Test-Path -LiteralPath $inputPath) { (Get-FileHash -Algorithm SHA256 -LiteralPath $inputPath).Hash.ToLowerInvariant() } else { $null }
  $outputHashAfterFailure = if (Test-Path -LiteralPath $outputPath) { (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash.ToLowerInvariant() } else { $null }
  $result = [ordered]@{
    schemaVersion = 'slidewright-template-matrix-powerpoint/v1'
    valid = $false
    fixtureId = $FixtureId
    application = 'Microsoft PowerPoint'
    ownership = $ownership
    automationProcessOwned = $ownsProcess
    sourceUnchanged = $inputHashBefore -eq $inputHashAfterFailure
    inputSha256 = $inputHashBefore
    inputSha256After = $inputHashAfterFailure
    outputSha256 = $outputHashAfterFailure
    beforeSave = $null
    afterReopen = $null
  }
}
$result.ownedProcessExitedNaturally = $ownedProcessExitedNaturally
$result.failureStage = if ($primaryError) { $stage } else { $null }
$result.error = $primaryError
$result.cleanupError = $cleanupError
$result.valid = [bool]$result.valid -and $ownedProcessExitedNaturally -and -not $primaryError -and -not $cleanupError
Write-JsonAtomically $result $reportPath 65
[ordered]@{
  valid = [bool]$result.valid
  fixtureId = $FixtureId
  reportJson = $reportPath
  slideCount = Get-OptionalValue { [int]$result.dynamicSlideCount }
  sourceUnchanged = Get-OptionalValue { [bool]$result.sourceUnchanged }
  exactLiveSemanticStatePreserved = Get-OptionalValue { [bool]$result.exactLiveSemanticStatePreserved }
  ownedProcessExitedNaturally = [bool]$ownedProcessExitedNaturally
} | ConvertTo-Json -Depth 4

if ($primaryError -and $cleanupError) { throw "$primaryError Cleanup also failed: $cleanupError" }
if ($primaryError) { throw $primaryError }
if ($cleanupError) { throw $cleanupError }
if (-not $result.valid) { throw 'C10 PowerPoint round-trip did not satisfy its validity contract.' }
