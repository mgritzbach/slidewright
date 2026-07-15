param(
    [Parameter(Mandatory = $true)][string]$InputPptx,
    [Parameter(Mandatory = $true)][string]$ReportJson
)

$ErrorActionPreference = "Stop"
$input = [System.IO.Path]::GetFullPath($InputPptx)
$report = [System.IO.Path]::GetFullPath($ReportJson)
$powerPoint = New-Object -ComObject PowerPoint.Application
$presentation = $null
try {
    $presentation = $powerPoint.Presentations.Open($input, $true, $false, $false)
    $items = @()
    $valid = $true
    foreach ($slide in $presentation.Slides) {
        foreach ($shape in $slide.Shapes) {
            if ($shape.HasTextFrame -ne -1 -or $shape.TextFrame2.HasText -ne -1) { continue }
            $availableHeight = [double]$shape.Height - [double]$shape.TextFrame2.MarginTop - [double]$shape.TextFrame2.MarginBottom
            $availableWidth = [double]$shape.Width - [double]$shape.TextFrame2.MarginLeft - [double]$shape.TextFrame2.MarginRight
            $boundHeight = [double]$shape.TextFrame2.TextRange.BoundHeight
            $boundWidth = [double]$shape.TextFrame2.TextRange.BoundWidth
            $heightFits = $boundHeight -le ($availableHeight + 1.0)
            $widthFits = $boundWidth -le ($availableWidth + 1.0)
            $valid = $valid -and $heightFits -and $widthFits
            $items += [ordered]@{
                slide = $slide.SlideIndex
                shape = $shape.Name
                boundHeightPt = [math]::Round($boundHeight, 3)
                availableHeightPt = [math]::Round($availableHeight, 3)
                boundWidthPt = [math]::Round($boundWidth, 3)
                availableWidthPt = [math]::Round($availableWidth, 3)
                heightFits = $heightFits
                widthFits = $widthFits
            }
        }
    }
    $result = [ordered]@{
        valid = $valid
        application = "Microsoft PowerPoint"
        version = $powerPoint.Version
        slides = $presentation.Slides.Count
        textShapes = $items.Count
        items = $items
    }
    New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($report)) | Out-Null
    $result | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $report
    $result | ConvertTo-Json -Depth 8
    if (-not $valid) { exit 1 }
} finally {
    if ($presentation) { $presentation.Close() }
    $powerPoint.Quit()
    if ($presentation) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
