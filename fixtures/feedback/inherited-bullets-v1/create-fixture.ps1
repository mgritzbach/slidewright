param(
    [string]$OutputPptx = (Join-Path $PSScriptRoot "slidewright-inherited-empty-bullets.pptx")
)

$ErrorActionPreference = "Stop"
$base = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\template\mit-v1\slidewright-mit-template.pptx"))
$output = [System.IO.Path]::GetFullPath($OutputPptx)
New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($output)) | Out-Null
if (Test-Path -LiteralPath $output) { Remove-Item -Force -LiteralPath $output }

$powerPoint = New-Object -ComObject PowerPoint.Application
$presentation = $null
try {
    $presentation = $powerPoint.Presentations.Open($base, $false, $false, $false)
    $presentation.Slides.Item(1).Shapes.Item("MIT Fixture Title").TextFrame2.TextRange.Text = "Inherited bullet hygiene"
    $body = $presentation.Slides.Item(1).Shapes.Item("MIT Fixture Body").TextFrame2.TextRange
    $body.Text = "Three priorities`r`rOne accountable owner`r `rA decision by Friday`r"
    $presentation.SaveAs($output, 24)
    $presentation.Close()
    $presentation = $null
} finally {
    if ($presentation) { $presentation.Close() }
    $powerPoint.Quit()
    if ($presentation) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}

& python (Join-Path $PSScriptRoot "..\..\template\mit-v1\sanitize-fixture-metadata.py") $output
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output "Created PowerPoint-authored inherited-bullet fixture: $output"
