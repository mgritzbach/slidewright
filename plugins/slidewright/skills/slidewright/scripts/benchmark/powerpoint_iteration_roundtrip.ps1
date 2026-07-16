param(
    [Parameter(Mandatory = $true)][string]$CasesJson,
    [Parameter(Mandatory = $true)][string]$ReportJson
)

$ErrorActionPreference = "Stop"
$cases = Get-Content -LiteralPath $CasesJson -Raw | ConvertFrom-Json
$powerPoint = $null
$openPresentation = $null

function Shape-Snapshot($presentation) {
    $items = @()
    for ($slideIndex = 1; $slideIndex -le $presentation.Slides.Count; $slideIndex++) {
        $slide = $presentation.Slides.Item($slideIndex)
        for ($shapeIndex = 1; $shapeIndex -le $slide.Shapes.Count; $shapeIndex++) {
            $shape = $slide.Shapes.Item($shapeIndex)
            $hasText = $false
            $text = $null
            $bold = $null
            $fontColor = $null
            try {
                $hasText = ([int]$shape.HasTextFrame -eq -1 -and [int]$shape.TextFrame2.HasText -eq -1)
                if ($hasText) {
                    $text = [string]$shape.TextFrame2.TextRange.Text
                    $bold = [int]$shape.TextFrame2.TextRange.Font.Bold
                    $fontColor = [int]$shape.TextFrame2.TextRange.Font.Fill.ForeColor.RGB
                }
            } catch { }
            $fillColor = $null
            $lineColor = $null
            try { if ([int]$shape.Fill.Visible -eq -1) { $fillColor = [int]$shape.Fill.ForeColor.RGB } } catch { }
            try { if ([int]$shape.Line.Visible -eq -1) { $lineColor = [int]$shape.Line.ForeColor.RGB } } catch { }
            $alternativeText = $null
            $title = $null
            try { $alternativeText = [string]$shape.AlternativeText } catch { }
            try { $title = [string]$shape.Title } catch { }
            $items += [ordered]@{
                slide = $slideIndex
                order = $shapeIndex
                name = [string]$shape.Name
                type = [int]$shape.Type
                left = [Math]::Round([double]$shape.Left, 3)
                top = [Math]::Round([double]$shape.Top, 3)
                width = [Math]::Round([double]$shape.Width, 3)
                height = [Math]::Round([double]$shape.Height, 3)
                rotation = [Math]::Round([double]$shape.Rotation, 3)
                hasText = $hasText
                text = $text
                bold = $bold
                fontColor = $fontColor
                fillColor = $fillColor
                lineColor = $lineColor
                alternativeText = $alternativeText
                title = $title
            }
        }
    }
    return $items
}

try {
    $powerPoint = New-Object -ComObject PowerPoint.Application
    $results = @()
    foreach ($case in $cases) {
        $input = (Resolve-Path -LiteralPath $case.input).Path
        $output = [System.IO.Path]::GetFullPath([string]$case.output)
        [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($output)) | Out-Null
        if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
        $inputHash = (Get-FileHash -LiteralPath $input -Algorithm SHA256).Hash.ToLowerInvariant()
        $openPresentation = $powerPoint.Presentations.Open($input, $false, $false, $false)
        $before = Shape-Snapshot $openPresentation
        $openPresentation.SaveAs($output, 24)
        $openPresentation.Close()
        $openPresentation = $null
        $reopened = $powerPoint.Presentations.Open($output, $true, $false, $false)
        $after = Shape-Snapshot $reopened
        $slideCount = $reopened.Slides.Count
        $reopened.Close()
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($reopened)
        $beforeJson = $before | ConvertTo-Json -Depth 8 -Compress
        $afterJson = $after | ConvertTo-Json -Depth 8 -Compress
        if ($beforeJson -ne $afterJson) { throw "PowerPoint round trip changed named shape properties for '$($case.id)'." }
        $outputHash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($inputHash -eq $outputHash) { throw "PowerPoint SaveAs did not produce a distinct package for '$($case.id)'." }
        $results += [ordered]@{
            id = [string]$case.id
            valid = $true
            slides = $slideCount
            namedShapes = $after.Count
            propertiesPreserved = $true
            inputSha256 = $inputHash
            outputSha256 = $outputHash
            output = $output
        }
    }
    $report = [ordered]@{
        valid = $true
        application = "Microsoft PowerPoint"
        version = [string]$powerPoint.Version
        cases = $results
    }
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($ReportJson))) | Out-Null
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportJson -Encoding UTF8
    $report | ConvertTo-Json -Depth 8
} finally {
    if ($null -ne $openPresentation) { $openPresentation.Close() }
    if ($null -ne $powerPoint) { $powerPoint.Quit() }
    foreach ($item in @($openPresentation, $powerPoint)) {
        if ($null -ne $item -and [System.Runtime.InteropServices.Marshal]::IsComObject($item)) {
            [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($item)
        }
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
