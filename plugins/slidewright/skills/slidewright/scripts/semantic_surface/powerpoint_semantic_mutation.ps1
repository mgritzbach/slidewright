param(
  [Parameter(Mandatory = $true)][string]$InputPptx,
  [Parameter(Mandatory = $true)][string]$ContractJson,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [Parameter(Mandatory = $true)][string]$ReportJson,
  [Parameter(Mandatory = $true)][string]$OwnershipRecordJson,
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
    purpose = 'semantic-native-object-mutation'
    state = 'started'
    ownershipRecordPath = [IO.Path]::GetFullPath($OwnershipRecordJson)
  }
  $intentTemporary = "$workerIntentPath.tmp-$PID"
  $intent | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $intentTemporary
  Move-Item -Force -LiteralPath $intentTemporary -Destination $workerIntentPath
}
$inputPath = [IO.Path]::GetFullPath($InputPptx)
$contractPath = [IO.Path]::GetFullPath($ContractJson)
$outputPath = [IO.Path]::GetFullPath($OutputDir)
$reportPath = [IO.Path]::GetFullPath($ReportJson)
$ownershipPath = [IO.Path]::GetFullPath($OwnershipRecordJson)
$contract = Get-Content -Raw -LiteralPath $contractPath | ConvertFrom-Json
if ([string]$contract.schemaVersion -ne 'slidewright-semantic-mutation/v1') { throw 'Unsupported semantic mutation contract.' }
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($reportPath)) | Out-Null
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($ownershipPath)) | Out-Null
if (Test-Path -LiteralPath $ownershipPath) { Remove-Item -Force -LiteralPath $ownershipPath }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SlidewrightMutationNativeMethods {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

function Retry([scriptblock]$Action, [int]$Attempts = 80) {
  $lastError = $null
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try { return & $Action } catch { $lastError = $_; Start-Sleep -Milliseconds 250 }
  }
  throw $lastError
}

function Release-ComReference([ref]$Reference) {
  $value = $Reference.Value
  if ($null -ne $value -and [Runtime.InteropServices.Marshal]::IsComObject($value)) {
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($value) } catch { }
  }
  $Reference.Value = $null
}

function Open-Presentation($Application, [string]$Path, [bool]$ReadOnly) {
  $presentations = $null
  try {
    $presentations = $Application.Presentations
    return Retry { $presentations.Open($Path, $ReadOnly, $false, $false) }
  } finally {
    Release-ComReference ([ref]$presentations)
  }
}

function Find-Shape($Slide, [string]$Name) {
  $shapes = $null
  $shape = $null
  try {
    $shapes = $Slide.Shapes
    $count = [int]$shapes.Count
    for ($index = 1; $index -le $count; $index++) {
      $shape = $shapes.Item($index)
      if ([string]$shape.Name -eq $Name) { return $shape }
      Release-ComReference ([ref]$shape)
    }
    throw "Shape '$Name' was not found on slide $($Slide.SlideIndex)."
  } finally {
    Release-ComReference ([ref]$shapes)
  }
}

function To-ObjectArray($Values) {
  $items = New-Object System.Collections.Generic.List[object]
  foreach ($value in @($Values)) { [void]$items.Add($value) }
  return [object[]]$items.ToArray()
}

function Read-Series($Chart) {
  $series = $null
  try {
    $series = $Chart.SeriesCollection(1)
    return [ordered]@{
      name = [string]$series.Name
      categories = @($series.XValues | ForEach-Object { [string]$_ })
      values = @($series.Values | ForEach-Object { [double]$_ })
    }
  } finally {
    Release-ComReference ([ref]$series)
  }
}

function Read-ChartReadability($Slide, [string]$Name) {
  $shape = $null
  $chart = $null
  $seriesCollection = $null
  $series = $null
  $categoryAxis = $null
  $valueAxis = $null
  $categoryTickLabels = $null
  $valueTickLabels = $null
  $categoryFont = $null
  $valueFont = $null
  $dataLabelsCollection = $null
  $dataLabelsFont = $null
  $dataLabel = $null
  try {
    $shape = Find-Shape $Slide $Name
    $chart = $shape.Chart
    $seriesCollection = $chart.SeriesCollection()
    $series = $seriesCollection.Item(1)
    $categoryAxis = $chart.Axes(1)
    $valueAxis = $chart.Axes(2)
    $categoryTickLabels = $categoryAxis.TickLabels
    $valueTickLabels = $valueAxis.TickLabels
    $categoryFont = $categoryTickLabels.Font
    $valueFont = $valueTickLabels.Font
    $dataLabelsCollection = $series.DataLabels()
    $dataLabelsFont = $dataLabelsCollection.Font
    $dataLabelRecords = @()
    $dataLabelCount = [int]$dataLabelsCollection.Count
    for ($index = 1; $index -le $dataLabelCount; $index++) {
      $dataLabel = $dataLabelsCollection.Item($index)
      # PowerPoint exposes DataLabel bounds in chart-local points. Do not add
      # the chart shape's slide offset; these values are relative to its frame.
      $dataLabelRecords += [ordered]@{
        index = $index
        text = [string]$dataLabel.Text
        leftPoints = [double]$dataLabel.Left
        topPoints = [double]$dataLabel.Top
        widthPoints = [double]$dataLabel.Width
        heightPoints = [double]$dataLabel.Height
      }
      Release-ComReference ([ref]$dataLabel)
    }
    return [ordered]@{
      name = $Name
      widthPoints = [double]$shape.Width
      heightPoints = [double]$shape.Height
      categoryCount = @($series.XValues).Count
      seriesCount = [int]$seriesCollection.Count
      categoryAxisFontPoints = [double]$categoryFont.Size
      valueAxisFontPoints = [double]$valueFont.Size
      dataLabelFontPoints = [double]$dataLabelsFont.Size
      dataLabels = $dataLabelRecords
    }
  } finally {
    Release-ComReference ([ref]$dataLabel)
    Release-ComReference ([ref]$dataLabelsFont)
    Release-ComReference ([ref]$dataLabelsCollection)
    Release-ComReference ([ref]$valueFont)
    Release-ComReference ([ref]$categoryFont)
    Release-ComReference ([ref]$valueTickLabels)
    Release-ComReference ([ref]$categoryTickLabels)
    Release-ComReference ([ref]$valueAxis)
    Release-ComReference ([ref]$categoryAxis)
    Release-ComReference ([ref]$series)
    Release-ComReference ([ref]$seriesCollection)
    Release-ComReference ([ref]$chart)
    Release-ComReference ([ref]$shape)
  }
}

function Read-TableReadability($Slide, [string]$Name) {
  $shape = $null
  $table = $null
  $rows = $null
  $columns = $null
  $tableCell = $null
  $cellShape = $null
  $frame = $null
  $range = $null
  $font = $null
  try {
    $shape = Find-Shape $Slide $Name
    $table = $shape.Table
    $rows = $table.Rows
    $columns = $table.Columns
    $rowCount = [int]$rows.Count
    $columnCount = [int]$columns.Count
    $cells = @()
    for ($row = 1; $row -le $rowCount; $row++) {
      for ($column = 1; $column -le $columnCount; $column++) {
        try {
          $tableCell = $table.Cell($row, $column)
          $cellShape = $tableCell.Shape
          $frame = $cellShape.TextFrame2
          $range = $frame.TextRange
          $font = $range.Font
          $marginLeft = [double]$frame.MarginLeft
          $marginRight = [double]$frame.MarginRight
          $marginTop = [double]$frame.MarginTop
          $marginBottom = [double]$frame.MarginBottom
          $boundWidth = [double]$range.BoundWidth
          $boundHeight = [double]$range.BoundHeight
          $availableWidth = [double]$cellShape.Width - $marginLeft - $marginRight
          $availableHeight = [double]$cellShape.Height - $marginTop - $marginBottom
          $cells += [ordered]@{
            row = $row
            column = $column
            text = [string]$range.Text
            fontPoints = [double]$font.Size
            marginLeftPoints = $marginLeft
            marginRightPoints = $marginRight
            marginTopPoints = $marginTop
            marginBottomPoints = $marginBottom
            boundWidthPoints = $boundWidth
            boundHeightPoints = $boundHeight
            availableWidthPoints = $availableWidth
            availableHeightPoints = $availableHeight
            fits = ($boundWidth -le $availableWidth + 0.5) -and ($boundHeight -le $availableHeight + 0.5)
          }
        } finally {
          Release-ComReference ([ref]$font)
          Release-ComReference ([ref]$range)
          Release-ComReference ([ref]$frame)
          Release-ComReference ([ref]$cellShape)
          Release-ComReference ([ref]$tableCell)
        }
      }
    }
    return [ordered]@{ name = $Name; rows = $rowCount; columns = $columnCount; cells = $cells }
  } finally {
    Release-ComReference ([ref]$columns)
    Release-ComReference ([ref]$rows)
    Release-ComReference ([ref]$table)
    Release-ComReference ([ref]$shape)
  }
}

function Capture-Readability($Presentation) {
  $slides = $null
  $chartSlide = $null
  $tableSlide = $null
  try {
    $slides = $Presentation.Slides
    $chartSlide = $slides.Item(2)
    $tableSlide = $slides.Item(3)
    return [ordered]@{
      charts = @(
        (Read-ChartReadability $chartSlide 'surface-02-bar-chart'),
        (Read-ChartReadability $chartSlide 'surface-02-column-chart')
      )
      table = Read-TableReadability $tableSlide 'surface-03-table'
    }
  } finally {
    Release-ComReference ([ref]$tableSlide)
    Release-ComReference ([ref]$chartSlide)
    Release-ComReference ([ref]$slides)
  }
}

function Replace-TableCellText($Shape, [int]$Row, [int]$Column, [string]$Text) {
  $table = $null
  $tableCell = $null
  $cellShape = $null
  $frame = $null
  $range = $null
  try {
    $table = $Shape.Table
    $tableCell = $table.Cell($Row, $Column)
    $cellShape = $tableCell.Shape
    $frame = $cellShape.TextFrame2
    $range = $frame.TextRange
    $before = [string]$range.Text
    $range.Text = $Text
    return [ordered]@{ before = $before; after = [string]$range.Text }
  } finally {
    Release-ComReference ([ref]$range)
    Release-ComReference ([ref]$frame)
    Release-ComReference ([ref]$cellShape)
    Release-ComReference ([ref]$tableCell)
    Release-ComReference ([ref]$table)
  }
}

function Read-TableCellText($Shape, [int]$Row, [int]$Column) {
  $table = $null
  $tableCell = $null
  $cellShape = $null
  $frame = $null
  $range = $null
  try {
    $table = $Shape.Table
    $tableCell = $table.Cell($Row, $Column)
    $cellShape = $tableCell.Shape
    $frame = $cellShape.TextFrame2
    $range = $frame.TextRange
    return [string]$range.Text
  } finally {
    Release-ComReference ([ref]$range)
    Release-ComReference ([ref]$frame)
    Release-ComReference ([ref]$cellShape)
    Release-ComReference ([ref]$tableCell)
    Release-ComReference ([ref]$table)
  }
}

function Read-ConnectorState($Shape, [bool]$IncludeEndpoints) {
  $line = $null
  $connectorFormat = $null
  $beginShape = $null
  $endShape = $null
  try {
    $line = $Shape.Line
    $state = [ordered]@{
      weightPoints = [double]$line.Weight
      dashStyle = [int]$line.DashStyle
    }
    if ($IncludeEndpoints) {
      $connectorFormat = $Shape.ConnectorFormat
      $beginShape = $connectorFormat.BeginConnectedShape
      $endShape = $connectorFormat.EndConnectedShape
      $state.from = [string]$beginShape.Name
      $state.to = [string]$endShape.Name
    }
    return $state
  } finally {
    Release-ComReference ([ref]$endShape)
    Release-ComReference ([ref]$beginShape)
    Release-ComReference ([ref]$connectorFormat)
    Release-ComReference ([ref]$line)
  }
}

function Set-ConnectorStyle($Shape, [double]$WeightPoints, [int]$DashStyle) {
  $line = $null
  try {
    $line = $Shape.Line
    $line.Weight = [single]$WeightPoints
    $line.DashStyle = $DashStyle
  } finally {
    Release-ComReference ([ref]$line)
  }
}

function Write-OwnershipRecord($Process, [string[]]$OwnedPresentationPaths, [string]$Version, [string]$Build) {
  $captureAcknowledgementPath = "$ownershipPath.runtime-captured"
  if (Test-Path -LiteralPath $captureAcknowledgementPath) { Remove-Item -Force -LiteralPath $captureAcknowledgementPath }
  $record = [ordered]@{
    schemaVersion = 'slidewright-owned-powerpoint/v1'
    processName = 'POWERPNT'
    processId = [int]$Process.Id
    processStartTime = $Process.StartTime.ToUniversalTime().ToString('o')
    workerProcessId = [int]$PID
    workerProcessName = [string](Get-Process -Id $PID -ErrorAction Stop).ProcessName
    workerProcessStartTime = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')
    purpose = 'semantic-native-object-mutation'
    version = $Version
    build = $Build
    expectedApplicationVisible = $false
    ownedPresentationPaths = @($OwnedPresentationPaths | ForEach-Object { [IO.Path]::GetFullPath($_) })
  }
  $temporary = "$ownershipPath.tmp"
  $record | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $temporary
  Move-Item -Force -LiteralPath $temporary -Destination $ownershipPath
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(30)
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $captureAcknowledgementPath) {
      try {
        $acknowledgement = Get-Content -Raw -LiteralPath $captureAcknowledgementPath | ConvertFrom-Json
        if ([string]$acknowledgement.schemaVersion -eq 'slidewright-runtime-capture-ack/v1' -and
            [int]$acknowledgement.processId -eq [int]$record.processId -and
            [string]$acknowledgement.processName -eq [string]$record.processName -and
            [string]$acknowledgement.processStartTime -eq [string]$record.processStartTime -and
            [string]$acknowledgement.runtimeReceiptSha256 -match '^[a-f0-9]{64}$') {
          Remove-Item -Force -LiteralPath $captureAcknowledgementPath
          return
        }
      } catch { }
    }
    Start-Sleep -Milliseconds 100
  }
  throw "Timed out waiting for runtime capture of owned PowerPoint process $($record.processId)."
}

function Test-EmptyHiddenApplication($Application) {
  $presentations = $null
  try {
    $presentations = $Application.Presentations
    $firstCount = [int]$presentations.Count
    $firstVisible = [int]$Application.Visible -ne 0
    Start-Sleep -Milliseconds 150
    $secondCount = [int]$presentations.Count
    $secondVisible = [int]$Application.Visible -ne 0
    return $firstCount -eq 0 -and $secondCount -eq 0 -and -not $firstVisible -and -not $secondVisible
  } finally {
    Release-ComReference ([ref]$presentations)
  }
}

function Close-CapturedOwnedPresentation($Application, $CapturedPresentation, [string[]]$OwnedPresentationPaths, [string]$Context) {
  if (-not $CapturedPresentation) { return }
  if (-not $Application) { throw "$Context close refused because the PowerPoint application reference is unavailable." }
  $presentations = $null
  $inventoryPresentation = $null
  try {
    $presentations = $Application.Presentations
    $allowedPaths = @($OwnedPresentationPaths | ForEach-Object { Get-NormalizedPresentationPath ([string]$_) } | Where-Object { $_ })
    $capturedPath = Get-NormalizedPresentationPath ([string]$CapturedPresentation.FullName) $allowedPaths
    if (-not $capturedPath -or -not ($allowedPaths -contains $capturedPath)) {
      throw "$Context close refused because the captured presentation path is not allowlisted."
    }
    for ($sample = 1; $sample -le 2; $sample++) {
      if ([int]$Application.Visible -ne 0) { throw "$Context close refused because the PowerPoint application became visible." }
      if ([int]$presentations.Count -ne 1) { throw "$Context close refused because the presentation inventory changed." }
      $inventoryPresentation = $presentations.Item(1)
      $inventoryPath = Get-NormalizedPresentationPath ([string]$inventoryPresentation.FullName) $allowedPaths
      $currentCapturedPath = Get-NormalizedPresentationPath ([string]$CapturedPresentation.FullName) $allowedPaths
      Release-ComReference ([ref]$inventoryPresentation)
      if ($inventoryPath -ne $capturedPath -or $currentCapturedPath -ne $capturedPath -or -not ($allowedPaths -contains $inventoryPath)) {
        throw "$Context close refused because the captured presentation identity changed."
      }
      if ($sample -eq 1) { Start-Sleep -Milliseconds 150 }
    }
    if ([int]$Application.Visible -ne 0 -or [int]$presentations.Count -ne 1) {
      throw "$Context close refused because PowerPoint state changed immediately before close."
    }
    $inventoryPresentation = $presentations.Item(1)
    $finalInventoryPath = Get-NormalizedPresentationPath ([string]$inventoryPresentation.FullName) $allowedPaths
    $finalCapturedPath = Get-NormalizedPresentationPath ([string]$CapturedPresentation.FullName) $allowedPaths
    Release-ComReference ([ref]$inventoryPresentation)
    if ($finalInventoryPath -ne $capturedPath -or $finalCapturedPath -ne $capturedPath -or -not ($allowedPaths -contains $finalInventoryPath)) {
      throw "$Context close refused because presentation identity changed immediately before close."
    }
    $CapturedPresentation.Close()
  } finally {
    Release-ComReference ([ref]$inventoryPresentation)
    Release-ComReference ([ref]$presentations)
  }
}

$caseOutputs = @($contract.cases | ForEach-Object { Join-Path $outputPath ("{0}.pptx" -f $_.id) })
$ownedPaths = @($inputPath) + @($caseOutputs)
$existingIds = @((Get-Process POWERPNT -ErrorAction SilentlyContinue) | ForEach-Object { [int]$_.Id })
if ($existingIds.Count -gt 0) { throw 'Semantic mutation requires PowerPoint to be fully closed before COM creation.' }

$powerPoint = $null
$presentation = $null
$ownedProcess = $null
$ownsProcess = $false
$results = @()
$version = $null
$build = $null
try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  if (-not $powerPoint) { throw 'PowerPoint COM application could not be created.' }
  $version = [string]$powerPoint.Version
  try { $build = [string]$powerPoint.Build } catch { $build = $null }
  Start-Sleep -Milliseconds 750
  [uint32]$resolvedProcessId = 0
  [void][SlidewrightMutationNativeMethods]::GetWindowThreadProcessId([IntPtr]([long]$powerPoint.HWND), [ref]$resolvedProcessId)
  $processId = [int]$resolvedProcessId
  if ($processId -eq 0 -or $existingIds -contains $processId) { throw 'Could not prove a newly owned PowerPoint mutation process.' }
  $resolved = Get-Process -Id $processId -ErrorAction Stop
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
  if ([string]$processInfo.CommandLine -notmatch '(?i)(?:^|\s)/AUTOMATION(?:\s|$)') { throw 'Resolved PowerPoint process is not an Office automation process.' }
  if (-not (Test-EmptyHiddenApplication $powerPoint)) { throw 'New PowerPoint mutation process is not empty and hidden.' }
  $ownedProcess = $resolved
  $ownsProcess = $true
  Write-OwnershipRecord $ownedProcess $ownedPaths $version $build

  foreach ($case in $contract.cases) {
    $outputDeck = Join-Path $outputPath ("{0}.pptx" -f $case.id)
    if (Test-Path -LiteralPath $outputDeck) { Remove-Item -Force -LiteralPath $outputDeck }
    $before = $null
    $after = $null
    $reopened = $null
    $readability = $null
    $slides = $null
    $slide = $null
    $shape = $null
    $chart = $null
    $series = $null
    $companion = $null

    $presentation = Open-Presentation $powerPoint $inputPath $false
    try {
      $slides = $presentation.Slides
      $slide = $slides.Item([int]$case.slide)
      $shape = Find-Shape $slide ([string]$case.target)
      switch ([string]$case.operation) {
        'replace-chart-data' {
          $chart = $shape.Chart
          $before = Read-Series $chart
          $series = $chart.SeriesCollection(1)
          $series.Name = [string]$case.expected.series[0].name
          $series.XValues = (To-ObjectArray $case.expected.categories)
          $series.Values = (To-ObjectArray $case.expected.series[0].values)
          try { $chart.Refresh() } catch { }
          $after = Read-Series $chart
        }
        'replace-table-cell' {
          $change = Replace-TableCellText $shape ([int]$case.cell.row) ([int]$case.cell.column) ([string]$case.cell.after)
          $before = $change.before
          $after = $change.after
        }
        'move-diagram-node' {
          $before = [ordered]@{ left = [double]$shape.Left; top = [double]$shape.Top }
          $shape.Left = [single]($shape.Left + [double]$case.deltaPoints.x)
          $shape.Top = [single]($shape.Top + [double]$case.deltaPoints.y)
          foreach ($companionName in $case.moveWithTarget) {
            $companion = Find-Shape $slide ([string]$companionName)
            try {
              $companion.Left = [single]($companion.Left + [double]$case.deltaPoints.x)
              $companion.Top = [single]($companion.Top + [double]$case.deltaPoints.y)
            } finally {
              Release-ComReference ([ref]$companion)
            }
          }
          $after = [ordered]@{ left = [double]$shape.Left; top = [double]$shape.Top }
        }
        'edit-connector-style' {
          $before = Read-ConnectorState $shape $false
          Set-ConnectorStyle $shape ([double]$case.expected.weightPoints) ([int]$case.expected.dashStyle)
          $after = Read-ConnectorState $shape $true
        }
        default { throw "Unsupported semantic mutation operation '$($case.operation)'." }
      }
      Retry { $presentation.SaveAs($outputDeck, 24) } | Out-Null
    } finally {
      Release-ComReference ([ref]$companion)
      Release-ComReference ([ref]$series)
      Release-ComReference ([ref]$chart)
      Release-ComReference ([ref]$shape)
      Release-ComReference ([ref]$slide)
      Release-ComReference ([ref]$slides)
      if ($presentation) {
        try { Close-CapturedOwnedPresentation $powerPoint $presentation $ownedPaths "Mutation case '$($case.id)' source presentation" }
        finally { Release-ComReference ([ref]$presentation) }
      }
    }

    $savedSlides = $null
    $savedSlide = $null
    $savedShape = $null
    $savedChart = $null
    $presentation = Open-Presentation $powerPoint $outputDeck $true
    try {
      $savedSlides = $presentation.Slides
      $savedSlide = $savedSlides.Item([int]$case.slide)
      $savedShape = Find-Shape $savedSlide ([string]$case.target)
      $reopened = switch ([string]$case.operation) {
        'replace-chart-data' {
          $savedChart = $savedShape.Chart
          Read-Series $savedChart
        }
        'replace-table-cell' { Read-TableCellText $savedShape ([int]$case.cell.row) ([int]$case.cell.column) }
        'move-diagram-node' { [ordered]@{ left = [double]$savedShape.Left; top = [double]$savedShape.Top } }
        'edit-connector-style' { Read-ConnectorState $savedShape $true }
      }
      $readability = Capture-Readability $presentation
    } finally {
      Release-ComReference ([ref]$savedChart)
      Release-ComReference ([ref]$savedShape)
      Release-ComReference ([ref]$savedSlide)
      Release-ComReference ([ref]$savedSlides)
      if ($presentation) {
        try { Close-CapturedOwnedPresentation $powerPoint $presentation $ownedPaths "Mutation case '$($case.id)' reopened output presentation" }
        finally { Release-ComReference ([ref]$presentation) }
      }
    }

    $results += [ordered]@{
      id = [string]$case.id
      output = $outputDeck
      before = $before
      afterMutation = $after
      afterSaveReopen = $reopened
      readability = $readability
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputDeck).Hash.ToLowerInvariant()
    }
  }

  $report = [ordered]@{
    schemaVersion = 'slidewright-semantic-mutation-powerpoint/v1'
    valid = $results.Count -eq $contract.cases.Count
    application = 'Microsoft PowerPoint'
    processId = [int]$ownedProcess.Id
    processStartTime = $ownedProcess.StartTime.ToUniversalTime().ToString('o')
    version = $version
    build = $build
    baselineSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $inputPath).Hash.ToLowerInvariant()
    mutationContractSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $contractPath).Hash.ToLowerInvariant()
    cases = $results
  }
  $report | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
  if (-not $report.valid) { exit 1 }
} finally {
  $cleanupError = $null
  if ($presentation) {
    try { Close-CapturedOwnedPresentation $powerPoint $presentation $ownedPaths 'Semantic mutation final cleanup' } catch { $cleanupError = $_.Exception.Message }
    finally { Release-ComReference ([ref]$presentation) }
  }
  if ($powerPoint) {
    if (-not $cleanupError -and $ownsProcess -and -not (Test-EmptyHiddenApplication $powerPoint)) {
      $cleanupError = 'Semantic mutation cleanup refused because the owned automation process became visible or gained a presentation.'
    }
    Release-ComReference ([ref]$powerPoint)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  if ($ownsProcess -and -not $cleanupError) {
    $ownedExited = $ownedProcess.WaitForExit(45000)
    if (-not $ownedExited) { $cleanupError = "Owned PowerPoint process $($ownedProcess.Id) did not exit naturally after COM release." }
  }
  if ($cleanupError) { throw $cleanupError }
}
