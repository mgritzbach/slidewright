param(
    [string]$OutputPptx = (Join-Path $PSScriptRoot "slidewright-design-profile-source.pptx")
)

$ErrorActionPreference = "Stop"
$msoFalse = 0
$msoTrue = -1
$msoShapeRectangle = 1
$msoShapeOval = 9
$ppSaveAsOpenXMLPresentation = 24
$ppAlignLeft = 1
$ppHorizontalGuide = 1
$ppVerticalGuide = 2

function Convert-HexColor([string]$hex) {
    $r = [Convert]::ToInt32($hex.Substring(0, 2), 16)
    $g = [Convert]::ToInt32($hex.Substring(2, 2), 16)
    $b = [Convert]::ToInt32($hex.Substring(4, 2), 16)
    return $r + (256 * $g) + (65536 * $b)
}

function Set-TextStyle($shape, [string]$fontName, [double]$fontSize, [string]$color, [bool]$bold) {
    $shape.TextFrame2.AutoSize = 0
    $shape.TextFrame2.WordWrap = -1
    $range = $shape.TextFrame2.TextRange
    $range.Font.Name = $fontName
    $range.Font.Size = $fontSize
    $range.Font.Bold = if ($bold) { $msoTrue } else { $msoFalse }
    $range.Font.Fill.ForeColor.RGB = Convert-HexColor $color
}

function Add-SolidRect($shapes, [string]$name, [double]$left, [double]$top, [double]$width, [double]$height, [string]$color) {
    $shape = $shapes.AddShape($msoShapeRectangle, $left, $top, $width, $height)
    $shape.Name = $name
    $shape.Fill.Solid()
    $shape.Fill.ForeColor.RGB = Convert-HexColor $color
    $shape.Line.Visible = $msoFalse
    return $shape
}

$output = [System.IO.Path]::GetFullPath($OutputPptx)
New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($output)) | Out-Null
$powerPoint = New-Object -ComObject PowerPoint.Application
$presentation = $null
try {
    $presentation = $powerPoint.Presentations.Add()
    $presentation.PageSetup.SlideWidth = 960
    $presentation.PageSetup.SlideHeight = 540
    $slideWidth = [double]$presentation.PageSetup.SlideWidth
    $slideHeight = [double]$presentation.PageSetup.SlideHeight

    while ($presentation.Guides.Count -gt 0) { $presentation.Guides.Item(1).Delete() }
    [void]$presentation.Guides.Add($ppVerticalGuide, 120)
    [void]$presentation.Guides.Add($ppVerticalGuide, ($slideWidth - 120))
    [void]$presentation.Guides.Add($ppHorizontalGuide, 72)
    [void]$presentation.Guides.Add($ppHorizontalGuide, ($slideHeight - 72))

    $master = $presentation.SlideMaster
    $master.Background.Fill.Solid()
    $master.Background.Fill.ForeColor.RGB = Convert-HexColor "F7F3EA"

    [void](Add-SolidRect $master.Shapes "SW Rail Left" 0 0 6 $slideHeight "2F263F")
    [void](Add-SolidRect $master.Shapes "SW Rail Right" ($slideWidth - 6) 0 6 $slideHeight "2F263F")
    [void](Add-SolidRect $master.Shapes "SW Rail Top" 0 0 $slideWidth 4 "2F263F")
    [void](Add-SolidRect $master.Shapes "SW Rail Bottom" 0 ($slideHeight - 4) $slideWidth 4 "2F263F")

    $logoMark = $master.Shapes.AddShape($msoShapeOval, 36, 24, 18, 18)
    $logoMark.Name = "SW Logo Mark"
    $logoMark.Fill.Solid()
    $logoMark.Fill.ForeColor.RGB = Convert-HexColor "E36B3D"
    $logoMark.Line.Visible = $msoFalse
    $logoWord = $master.Shapes.AddTextbox(1, 62, 22, 190, 22)
    $logoWord.Name = "SW Logo Wordmark"
    $logoWord.TextFrame2.TextRange.Text = "SLIDEWRIGHT"
    Set-TextStyle $logoWord "Arial" 11 "2F263F" $true
    $logo = $master.Shapes.Range(@("SW Logo Mark", "SW Logo Wordmark")).Group()
    $logo.Name = "SW Logo Group"

    $master.HeadersFooters.Footer.Visible = $msoTrue
    $master.HeadersFooters.Footer.Text = "SLIDEWRIGHT DESIGN PROFILE"
    $master.HeadersFooters.SlideNumber.Visible = $msoTrue

    $contentLayout = $master.CustomLayouts.Item(2)
    $contentLayout.Name = "SW Profile Content"
    [void](Add-SolidRect $contentLayout.Shapes "SW Limiter Left" 120 68 2 ($slideHeight - 136) "3D53E5")
    [void](Add-SolidRect $contentLayout.Shapes "SW Limiter Right" ($slideWidth - 122) 68 2 ($slideHeight - 136) "3D53E5")
    $contentTitle = $contentLayout.Shapes.Title
    $contentTitle.Left = 146
    $contentTitle.Top = 68
    $contentTitle.Width = ($slideWidth - 292)
    $contentTitle.Height = 62
    Set-TextStyle $contentTitle "Arial" 30 "2F263F" $true
    $contentBody = $contentLayout.Shapes.Placeholders.Item(2)
    $contentBody.Left = 146
    $contentBody.Top = 154
    $contentBody.Width = ($slideWidth - 292)
    $contentBody.Height = 290
    Set-TextStyle $contentBody "Arial" 20 "4A4552" $false

    $sectionLayout = $master.CustomLayouts.Item(3)
    $sectionLayout.Name = "SW Profile Section"
    [void](Add-SolidRect $sectionLayout.Shapes "SW Section Limiter Left" 120 68 2 ($slideHeight - 136) "3D53E5")
    [void](Add-SolidRect $sectionLayout.Shapes "SW Section Limiter Right" ($slideWidth - 122) 68 2 ($slideHeight - 136) "3D53E5")
    [void](Add-SolidRect $sectionLayout.Shapes "SW Declared Asymmetric Accent" 146 142 10 250 "E36B3D")
    [void](Add-SolidRect $sectionLayout.Shapes "SW Declared Rule Left" 184 420 3 36 "E36B3D")
    [void](Add-SolidRect $sectionLayout.Shapes "SW Declared Rule Right" ($slideWidth - 189) 420 5 36 "E36B3D")
    $sectionTitle = $sectionLayout.Shapes.Title
    $sectionTitle.Left = 184
    $sectionTitle.Top = 150
    $sectionTitle.Width = ($slideWidth - 330)
    $sectionTitle.Height = 84
    Set-TextStyle $sectionTitle "Arial" 36 "2F263F" $true
    if ($sectionLayout.Shapes.Placeholders.Count -ge 2) {
        $sectionBody = $sectionLayout.Shapes.Placeholders.Item(2)
        $sectionBody.Left = 184
        $sectionBody.Top = 250
        $sectionBody.Width = ($slideWidth - 330)
        $sectionBody.Height = 120
        Set-TextStyle $sectionBody "Arial" 18 "4A4552" $false
    }

    $slide1 = $presentation.Slides.AddSlide(1, $contentLayout)
    $slide1.FollowMasterBackground = $msoTrue
    $slide1.HeadersFooters.Footer.Visible = $msoTrue
    $slide1.HeadersFooters.Footer.Text = "SLIDEWRIGHT DESIGN PROFILE"
    $slide1.HeadersFooters.SlideNumber.Visible = $msoTrue
    $title1 = $slide1.Shapes.Title
    $title1.Name = "SW Content Title"
    $title1.TextFrame2.TextRange.Text = "Operating review"
    Set-TextStyle $title1 "Arial" 30 "2F263F" $true
    $title1.TextFrame2.TextRange.ParagraphFormat.Alignment = $ppAlignLeft
    $body1 = $slide1.Shapes.Placeholders.Item(2)
    $body1.Name = "SW Content Body"
    $body1.TextFrame2.TextRange.Text = "Three priorities" + [Environment]::NewLine + "One accountable owner" + [Environment]::NewLine + "A decision by Friday"
    Set-TextStyle $body1 "Arial" 20 "4A4552" $false
    $body1.TextFrame2.TextRange.ParagraphFormat.Alignment = $ppAlignLeft

    $slide2 = $presentation.Slides.AddSlide(2, $sectionLayout)
    $slide2.FollowMasterBackground = $msoTrue
    $slide2.HeadersFooters.Footer.Visible = $msoTrue
    $slide2.HeadersFooters.Footer.Text = "SLIDEWRIGHT DESIGN PROFILE"
    $slide2.HeadersFooters.SlideNumber.Visible = $msoTrue
    $title2 = $slide2.Shapes.Title
    $title2.Name = "SW Section Title"
    $title2.TextFrame2.TextRange.Text = "Decisions, not decoration"
    Set-TextStyle $title2 "Arial" 36 "2F263F" $true
    if ($slide2.Shapes.Placeholders.Count -ge 2) {
        $body2 = $slide2.Shapes.Placeholders.Item(2)
        $body2.Name = "SW Section Body"
        $body2.TextFrame2.TextRange.Text = "A source-bound section archetype"
        Set-TextStyle $body2 "Arial" 18 "4A4552" $false
        $body2.TextFrame2.TextRange.ParagraphFormat.Alignment = $ppAlignLeft
    }

    $presentation.SaveAs($output, $ppSaveAsOpenXMLPresentation)
    Write-Output "Created design-profile fixture: $output"
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

& python (Join-Path $PSScriptRoot "generate-asymmetry-manifest.py") $output (Join-Path $PSScriptRoot "asymmetry-manifest.json")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
