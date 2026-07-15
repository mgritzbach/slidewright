param(
    [Parameter(Mandatory = $true)][string]$InputPptx,
    [Parameter(Mandatory = $true)][string]$OutputPptx,
    [string]$ShapeName = "s1-title"
)

$ErrorActionPreference = "Stop"
$input = [System.IO.Path]::GetFullPath($InputPptx)
$output = [System.IO.Path]::GetFullPath($OutputPptx)
$powerPoint = New-Object -ComObject PowerPoint.Application
$presentation = $null
try {
    $presentation = $powerPoint.Presentations.Open($input, $true, $false, $false)
    $shape = $presentation.Slides.Item(1).Shapes.Item($ShapeName)
    $shape.TextFrame2.AutoSize = 0
    $shape.Height = 18
    New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($output)) | Out-Null
    $presentation.SaveAs($output, 24)
} finally {
    if ($presentation) { $presentation.Close() }
    $powerPoint.Quit()
    if ($shape) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shape) }
    if ($presentation) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
