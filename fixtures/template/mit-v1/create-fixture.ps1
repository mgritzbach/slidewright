param(
    [string]$OutputPptx = (Join-Path $PSScriptRoot "slidewright-mit-template.pptx")
)

$ErrorActionPreference = "Stop"
$msoFalse = 0
$msoTrue = -1
$msoShapeRectangle = 1
$ppSaveAsOpenXMLPresentation = 24
$ppAlignLeft = 1
$ppAlignCenter = 2

function Set-TextStyle($shape, [string]$fontName, [double]$fontSize, [int]$color, [bool]$bold) {
    $range = $shape.TextFrame2.TextRange
    $range.Font.Name = $fontName
    $range.Font.Size = $fontSize
    $range.Font.Bold = if ($bold) { $msoTrue } else { $msoFalse }
    $range.Font.Fill.ForeColor.RGB = $color
}

$output = [System.IO.Path]::GetFullPath($OutputPptx)
New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($output)) | Out-Null
$powerPoint = New-Object -ComObject PowerPoint.Application
$presentation = $null
try {
    $presentation = $powerPoint.Presentations.Add()
    $presentation.PageSetup.SlideSize = 16
    $master = $presentation.SlideMaster
    $master.Background.Fill.Solid()
    $master.Background.Fill.ForeColor.RGB = 0xF7F3EA

    $chrome = $master.Shapes.AddShape($msoShapeRectangle, 0, 0, $presentation.PageSetup.SlideWidth, 16)
    $chrome.Name = "SW Master Chrome"
    $chrome.Fill.Solid()
    $chrome.Fill.ForeColor.RGB = 0x2F263F
    $chrome.Line.Visible = $msoFalse

    $brand = $master.Shapes.AddTextbox(1, 54, 28, 360, 28)
    $brand.Name = "SW Master Brand"
    $brand.TextFrame2.TextRange.Text = "SLIDEWRIGHT // MIT GOLDEN TEMPLATE"
    Set-TextStyle $brand "Arial" 11 0x2F263F $true

    $master.HeadersFooters.Footer.Visible = $msoTrue
    $master.HeadersFooters.Footer.Text = "SLIDEWRIGHT MIT TEMPLATE"
    $master.HeadersFooters.SlideNumber.Visible = $msoTrue

    $layout = $master.CustomLayouts.Item(2)
    $layout.Name = "Slidewright MIT Title and Content"
    $accent = $layout.Shapes.AddShape($msoShapeRectangle, 54, 154, 8, 330)
    $accent.Name = "SW Layout Accent"
    $accent.Fill.Solid()
    $accent.Fill.ForeColor.RGB = 0x3D53E5
    $accent.Line.Visible = $msoFalse

    $layoutTitle = $layout.Shapes.Title
    $layoutTitle.Left = 78
    $layoutTitle.Top = 76
    $layoutTitle.Width = 810
    $layoutTitle.Height = 68
    Set-TextStyle $layoutTitle "Arial" 30 0x2F263F $true

    $layoutBody = $layout.Shapes.Placeholders.Item(2)
    $layoutBody.Left = 78
    $layoutBody.Top = 176
    $layoutBody.Width = 760
    $layoutBody.Height = 310
    Set-TextStyle $layoutBody "Arial" 20 0x4A4552 $false

    $slide1 = $presentation.Slides.AddSlide(1, $layout)
    $slide1.FollowMasterBackground = $msoTrue
    $slide1.HeadersFooters.Footer.Visible = $msoTrue
    $slide1.HeadersFooters.Footer.Text = "SLIDEWRIGHT MIT TEMPLATE"
    $slide1.HeadersFooters.SlideNumber.Visible = $msoTrue
    $title1 = $slide1.Shapes.Title
    $title1.Name = "MIT Fixture Title"
    $title1.TextFrame2.TextRange.Text = "Quarterly operating review"
    $title1.TextFrame2.TextRange.ParagraphFormat.Alignment = $ppAlignLeft
    $body1 = $slide1.Shapes.Placeholders.Item(2)
    $body1.Name = "MIT Fixture Body"
    $body1.TextFrame2.TextRange.Text = "Three priorities`rOne accountable owner`rA decision by Friday"
    $body1.TextFrame2.TextRange.ParagraphFormat.Alignment = $ppAlignLeft

    $slide2 = $presentation.Slides.AddSlide(2, $layout)
    $slide2.FollowMasterBackground = $msoTrue
    $slide2.HeadersFooters.Footer.Visible = $msoTrue
    $slide2.HeadersFooters.Footer.Text = "SLIDEWRIGHT MIT TEMPLATE"
    $slide2.HeadersFooters.SlideNumber.Visible = $msoTrue
    $title2 = $slide2.Shapes.Title
    $title2.Name = "MIT Preserve Title"
    $title2.TextFrame2.TextRange.Text = "Preserve-only control"
    $body2 = $slide2.Shapes.Placeholders.Item(2)
    $body2.Name = "MIT Preserve Body"
    $body2.TextFrame2.TextRange.Text = "This slide must remain unchanged."
    $body2.TextFrame2.TextRange.ParagraphFormat.Alignment = $ppAlignCenter

    $presentation.SaveAs($output, $ppSaveAsOpenXMLPresentation)
    Write-Output "Created PowerPoint-authored MIT fixture: $output"
} finally {
    if ($presentation) { $presentation.Close() }
    $powerPoint.Quit()
    if ($presentation) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}

& python (Join-Path $PSScriptRoot "sanitize-fixture-metadata.py") $output
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
