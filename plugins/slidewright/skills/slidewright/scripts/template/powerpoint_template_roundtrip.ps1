param(
    [Parameter(Mandatory = $true)][string]$InputPptx,
    [Parameter(Mandatory = $true)][string]$OutputPptx,
    [Parameter(Mandatory = $true)][string]$ReportJson
)

$ErrorActionPreference = "Stop"
$input = [System.IO.Path]::GetFullPath($InputPptx)
$output = [System.IO.Path]::GetFullPath($OutputPptx)
$report = [System.IO.Path]::GetFullPath($ReportJson)
New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($output)) | Out-Null
if (Test-Path -LiteralPath $output) { Remove-Item -Force -LiteralPath $output }

function Capture-State($presentation) {
    $slide1 = $presentation.Slides.Item(1)
    $slide2 = $presentation.Slides.Item(2)
    return [ordered]@{
        slides = $presentation.Slides.Count
        masters = $presentation.Designs.Count
        layoutName = $slide1.CustomLayout.Name
        slide1Shapes = $slide1.Shapes.Count
        slide2Shapes = $slide2.Shapes.Count
        title = $slide1.Shapes.Item("MIT Fixture Title").TextFrame2.TextRange.Text
        body = $slide1.Shapes.Item("MIT Fixture Body").TextFrame2.TextRange.Text -replace "`r", "`n"
        preserveTitle = $slide2.Shapes.Item("MIT Preserve Title").TextFrame2.TextRange.Text
        preserveBody = $slide2.Shapes.Item("MIT Preserve Body").TextFrame2.TextRange.Text
        footer = $slide1.HeadersFooters.Footer.Text
        footerVisible = [bool]$slide1.HeadersFooters.Footer.Visible
        slideNumberVisible = [bool]$slide1.HeadersFooters.SlideNumber.Visible
    }
}

$powerPoint = New-Object -ComObject PowerPoint.Application
try {
    $presentation = $powerPoint.Presentations.Open($input, $false, $false, $false)
    $before = Capture-State $presentation
    $titleRange = $presentation.Slides.Item(1).Shapes.Item("MIT Fixture Title").TextFrame2.TextRange
    $originalTitle = $titleRange.Text
    $titleRange.Text = "$originalTitle "
    $titleRange.Text = $originalTitle
    $presentation.SaveAs($output, 24)
    $presentation.Close()
    $presentation = $powerPoint.Presentations.Open($output, $true, $false, $false)
    $after = Capture-State $presentation
    $presentation.Close()
    $expected = [ordered]@{
        title = "Annual operating review"
        body = "Four priorities`nOne accountable owner`nA decision by Thursday"
        preserveTitle = "Preserve-only control"
        preserveBody = "This slide must remain unchanged."
        footer = "SLIDEWRIGHT MIT TEMPLATE"
        layoutName = "Slidewright MIT Title and Content"
    }
    $inputSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $input).Hash.ToLowerInvariant()
    $outputSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $output).Hash.ToLowerInvariant()
    $serialized = $inputSha256 -ne $outputSha256
    $valid = $serialized -and (($before | ConvertTo-Json -Compress) -eq ($after | ConvertTo-Json -Compress))
    foreach ($key in $expected.Keys) { $valid = $valid -and ($after[$key] -eq $expected[$key]) }
    $valid = $valid -and $after.footerVisible -and $after.slideNumberVisible -and ($after.slides -eq 2)
    $result = [ordered]@{ valid = $valid; application = "Microsoft PowerPoint"; serializedBySaveAs = $serialized; inputSha256 = $inputSha256; outputSha256 = $outputSha256; beforeSave = $before; afterReopen = $after; expected = $expected }
    New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($report)) | Out-Null
    $result | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $report
    $result | ConvertTo-Json -Depth 8
    if (-not $valid) { exit 1 }
} finally {
    $powerPoint.Quit()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
