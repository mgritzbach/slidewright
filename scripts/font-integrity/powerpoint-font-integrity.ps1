param(
  [Parameter(Mandatory = $true)][string]$FixtureDir,
  [Parameter(Mandatory = $true)][string]$OutputDir,
  [Parameter(Mandatory = $true)][string]$ReportJson
)

$ErrorActionPreference = 'Stop'
$family = 'Slidewright Fixture Sans'
$missingFamily = 'Slidewright Definitely Missing Sans 9F24'
$fixturePath = [IO.Path]::GetFullPath($FixtureDir)
$outputPath = [IO.Path]::GetFullPath($OutputDir)
$reportPath = [IO.Path]::GetFullPath($ReportJson)
$fontFiles = @(
  'SWFixture-Regular.ttf',
  'SWFixture-Bold.ttf',
  'SWFixture-Italic.ttf',
  'SWFixture-BoldItalic.ttf'
)

if (-not (Test-Path -LiteralPath $fixturePath -PathType Container)) { throw "Font fixture directory does not exist: $fixturePath" }
foreach ($fontFile in $fontFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $fixturePath $fontFile) -PathType Leaf)) { throw "Font fixture is incomplete: $fontFile" }
}

$preexistingPowerPoint = @((Get-Process POWERPNT -ErrorAction SilentlyContinue) | ForEach-Object { [int]$_.Id })
if ($preexistingPowerPoint.Count -gt 0) {
  throw 'C11 font-integrity benchmark requires PowerPoint to be fully closed; refusing to attach to a pre-existing user session.'
}

Add-Type -AssemblyName System.Drawing
$installedFamilies = @((New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name })
if ($installedFamilies -contains $family) {
  throw "The collision-resistant C11 fixture family '$family' is already installed; refusing ambiguous font provenance."
}
if ($installedFamilies -contains $missingFamily) {
  throw "The C11 missing-font control family unexpectedly exists: $missingFamily"
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SlidewrightFontNativeMethods {
  [DllImport("gdi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int AddFontResourceEx(string fileName, uint flags, IntPtr reserved);
  [DllImport("gdi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool RemoveFontResourceEx(string fileName, uint flags, IntPtr reserved);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
}
"@

function Broadcast-FontChange {
  $result = [IntPtr]::Zero
  [void][SlidewrightFontNativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x001d, [IntPtr]::Zero, $null, 0x0002, 1000, [ref]$result)
}

function Optional([scriptblock]$Action) {
  try { return & $Action } catch { return $null }
}

function Round4($Value) {
  if ($null -eq $Value) { return $null }
  return [Math]::Round([double]$Value, 4)
}

function Set-TextBoxStyle($Shape, [double]$FontSize, [bool]$Bold = $false, [bool]$Italic = $false) {
  $frame = $Shape.TextFrame2
  $frame.MarginLeft = 12
  $frame.MarginRight = 12
  $frame.MarginTop = 8
  $frame.MarginBottom = 8
  try { $frame.WordWrap = -1 } catch { }
  $range = $frame.TextRange
  $range.Font.Name = $family
  $range.Font.Size = $FontSize
  $range.Font.Bold = if ($Bold) { -1 } else { 0 }
  $range.Font.Italic = if ($Italic) { -1 } else { 0 }
}

function Add-FontTextBox($Shapes, [string]$Name, [string]$Text, [double]$Left, [double]$Top, [double]$Width, [double]$Height, [double]$FontSize, [bool]$Bold = $false, [bool]$Italic = $false) {
  $shape = $Shapes.AddTextbox(1, $Left, $Top, $Width, $Height)
  $shape.Name = $Name
  $shape.TextFrame2.TextRange.Text = $Text
  Set-TextBoxStyle $shape $FontSize $Bold $Italic
  return $shape
}

function Capture-Text($Shape) {
  $frame = $Shape.TextFrame2
  $range = $frame.TextRange
  $runs = @()
  $runCollection = $range.Runs()
  for ($index = 1; $index -le [int]$runCollection.Count; $index++) {
    $run = $runCollection.Item($index)
    $runs += [ordered]@{
      text = [string]$run.Text
      typeface = [string](Optional { $run.Font.Name })
      size = Round4 (Optional { $run.Font.Size })
      bold = Optional { [int]$run.Font.Bold }
      italic = Optional { [int]$run.Font.Italic }
      underline = Optional { [int]$run.Font.UnderlineStyle }
    }
  }
  return [ordered]@{
    value = [string]$range.Text
    marginLeft = Round4 $frame.MarginLeft
    marginRight = Round4 $frame.MarginRight
    marginTop = Round4 $frame.MarginTop
    marginBottom = Round4 $frame.MarginBottom
    runs = $runs
  }
}

function Capture-Shape($Shape, [string]$Path) {
  $state = [ordered]@{ path = $Path; name = [string]$Shape.Name; type = [int]$Shape.Type; text = $null; table = @(); group = @() }
  if ([int]$Shape.HasTextFrame -eq -1 -and [int]$Shape.TextFrame2.HasText -eq -1) {
    $state.text = Capture-Text $Shape
  }
  if ([int]$Shape.HasTable -eq -1) {
    for ($row = 1; $row -le [int]$Shape.Table.Rows.Count; $row++) {
      for ($column = 1; $column -le [int]$Shape.Table.Columns.Count; $column++) {
        $state.table += [ordered]@{ row = $row; column = $column; text = Capture-Text $Shape.Table.Cell($row, $column).Shape }
      }
    }
  }
  if ([int]$Shape.Type -eq 6) {
    for ($index = 1; $index -le [int]$Shape.GroupItems.Count; $index++) {
      $state.group += Capture-Shape $Shape.GroupItems.Item($index) "$Path/group[$index]"
    }
  }
  return $state
}

function Capture-Shapes($Shapes, [string]$Prefix) {
  $states = @()
  for ($index = 1; $index -le [int]$Shapes.Count; $index++) {
    $states += Capture-Shape $Shapes.Item($index) "$Prefix/shape[$index]"
  }
  return $states
}

function Capture-Presentation($Presentation) {
  $slides = @()
  for ($slideIndex = 1; $slideIndex -le [int]$Presentation.Slides.Count; $slideIndex++) {
    $slide = $Presentation.Slides.Item($slideIndex)
    $slides += [ordered]@{
      index = $slideIndex
      name = [string]$slide.Name
      layout = [string]$slide.CustomLayout.Name
      shapes = Capture-Shapes $slide.Shapes "slide[$slideIndex]"
    }
  }
  $layouts = @()
  for ($layoutIndex = 1; $layoutIndex -le [int]$Presentation.SlideMaster.CustomLayouts.Count; $layoutIndex++) {
    $layout = $Presentation.SlideMaster.CustomLayouts.Item($layoutIndex)
    if ([string]$layout.Name -eq 'Slidewright Font Integrity Layout') {
      $layouts += [ordered]@{ name = [string]$layout.Name; shapes = Capture-Shapes $layout.Shapes "layout[$layoutIndex]" }
    }
  }
  $fonts = @()
  for ($fontIndex = 1; $fontIndex -le [int]$Presentation.Fonts.Count; $fontIndex++) {
    $font = $Presentation.Fonts.Item($fontIndex)
    $fonts += [ordered]@{ name = [string]$font.Name; embedded = Optional { [int]$font.Embedded } }
  }
  $fonts = @($fonts | Sort-Object name)
  return [ordered]@{
    slideCount = [int]$Presentation.Slides.Count
    master = Capture-Shapes $Presentation.SlideMaster.Shapes 'master'
    layouts = $layouts
    slides = $slides
    fonts = $fonts
  }
}

function Add-ComplexFixture($Presentation) {
  $Presentation.PageSetup.SlideWidth = 960
  $Presentation.PageSetup.SlideHeight = 540

  $masterFooter = Add-FontTextBox $Presentation.SlideMaster.Shapes 'SW-Font-Master-Footer' 'SLIDEWRIGHT FONT INTEGRITY' 48 500 864 24 10 $true
  $masterFooter.TextFrame2.TextRange.Font.Fill.ForeColor.RGB = 0x666666

  $layout = $Presentation.SlideMaster.CustomLayouts.Add($Presentation.SlideMaster.CustomLayouts.Count + 1)
  $layout.Name = 'Slidewright Font Integrity Layout'
  $layoutLabel = Add-FontTextBox $layout.Shapes 'SW-Font-Layout-Label' 'EDITABLE TYPE SYSTEM' 48 30 864 24 12 $true
  $layoutLabel.TextFrame2.TextRange.Font.Fill.ForeColor.RGB = 0x6D4AFF

  $slide1 = $Presentation.Slides.AddSlide(1, $layout)
  $slide1.Name = 'Font hierarchy and mixed runs'
  [void](Add-FontTextBox $slide1.Shapes 'SW-Font-Title' 'Fonts stay editable through every handoff' 48 70 864 62 34 $true)
  [void](Add-FontTextBox $slide1.Shapes 'SW-Font-Subtitle' 'The same native family, size, emphasis, and insets survive both PowerPoint round trips.' 48 138 864 44 18)

  $mixedText = 'Regular | Bold | Italic | Bold italic'
  $mixed = Add-FontTextBox $slide1.Shapes 'SW-Font-Mixed-Runs' $mixedText 48 215 864 64 24
  $mixedRange = $mixed.TextFrame2.TextRange
  $boldStart = $mixedText.IndexOf('Bold') + 1
  $italicStart = $mixedText.IndexOf('Italic') + 1
  $boldItalicStart = $mixedText.LastIndexOf('Bold italic') + 1
  $mixedRange.Characters($boldStart, 4).Font.Bold = -1
  $mixedRange.Characters($italicStart, 6).Font.Italic = -1
  $mixedRange.Characters($boldItalicStart, 11).Font.Bold = -1
  $mixedRange.Characters($boldItalicStart, 11).Font.Italic = -1

  $groupHeader = Add-FontTextBox $slide1.Shapes 'SW-Font-Group-Header' 'Template-bound group' 48 315 280 42 18 $true
  $groupBody = Add-FontTextBox $slide1.Shapes 'SW-Font-Group-Body' 'Ungrouping must not change typography.' 48 357 280 66 16
  $group = $slide1.Shapes.Range(@($groupHeader.Name, $groupBody.Name)).Group()
  $group.Name = 'SW-Font-Editable-Group'
  [void](Add-FontTextBox $slide1.Shapes 'SW-Font-Metrics' 'Integer sizes: 34 / 24 / 18 / 16 / 12 / 10 pt' 372 315 540 52 18)
  [void](Add-FontTextBox $slide1.Shapes 'SW-Font-Insets' 'Symmetric left/right insets remain 12 pt.' 372 375 540 48 16 $false $true)

  $slide2 = $Presentation.Slides.AddSlide(2, $layout)
  $slide2.Name = 'Font table and paragraph styles'
  [void](Add-FontTextBox $slide2.Shapes 'SW-Font-Table-Title' 'A native table retains the same four-style family' 48 70 864 56 30 $true)
  $tableShape = $slide2.Shapes.AddTable(3, 3, 48, 155, 864, 240)
  $tableShape.Name = 'SW-Font-Native-Table'
  $values = @(
    @('STYLE', 'POWERPOINT STATE', 'EXPECTED RESULT'),
    @('Regular + bold', 'Editable native text', 'Exact family retained'),
    @('Italic + bold italic', 'Two save/reopen cycles', 'Embedded parts retained')
  )
  for ($row = 1; $row -le 3; $row++) {
    for ($column = 1; $column -le 3; $column++) {
      $cell = $tableShape.Table.Cell($row, $column).Shape
      $cell.TextFrame2.TextRange.Text = $values[$row - 1][$column - 1]
      $cellFontSize = if ($row -eq 1) { 16 } else { 14 }
      Set-TextBoxStyle $cell $cellFontSize ($row -eq 1) ($row -eq 3)
      if ($row -eq 3 -and $column -eq 1) { $cell.TextFrame2.TextRange.Font.Bold = -1 }
    }
  }
  [void](Add-FontTextBox $slide2.Shapes 'SW-Font-Control-Note' 'Any missing family, changed run, or lost embedded part is a release-blocking error.' 48 425 864 44 16 $true)
}

$localFontDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Fonts'
$registryPath = 'HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts'
$installed = @()
$powerPoint = $null
$presentation = $null

New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($reportPath)) | Out-Null
New-Item -ItemType Directory -Force -Path $localFontDir | Out-Null
New-Item -ItemType Directory -Force -Path $registryPath | Out-Null

try {
  foreach ($fontFile in $fontFiles) {
    $source = Join-Path $fixturePath $fontFile
    $installedName = "Slidewright-C11-$fontFile"
    $destination = Join-Path $localFontDir $installedName
    $registryName = "Slidewright C11 $fontFile (TrueType)"
    if (Test-Path -LiteralPath $destination) { throw "C11 temporary font path already exists: $destination" }
    Copy-Item -LiteralPath $source -Destination $destination
    New-ItemProperty -Path $registryPath -Name $registryName -Value $installedName -PropertyType String -Force | Out-Null
    if ([SlidewrightFontNativeMethods]::AddFontResourceEx($destination, 0, [IntPtr]::Zero) -le 0) {
      throw "Windows refused to load C11 fixture font: $fontFile"
    }
    $installed += [ordered]@{ path = $destination; registryName = $registryName }
  }
  Broadcast-FontChange

  $powerPoint = New-Object -ComObject PowerPoint.Application
  $powerPoint.Visible = -1

  $sourceDeck = Join-Path $outputPath 'font-integrity-source.pptx'
  $roundtrip1 = Join-Path $outputPath 'font-integrity-roundtrip-1.pptx'
  $roundtrip2 = Join-Path $outputPath 'font-integrity-roundtrip-2.pptx'
  $missingControl = Join-Path $outputPath 'font-integrity-missing-font-control.pptx'

  foreach ($candidate in @($sourceDeck, $roundtrip1, $roundtrip2, $missingControl)) {
    if (Test-Path -LiteralPath $candidate) { Remove-Item -Force -LiteralPath $candidate }
  }

  $presentation = $powerPoint.Presentations.Add(-1)
  Add-ComplexFixture $presentation
  $presentation.SaveAs($sourceDeck, 24, -1)
  $state0 = Capture-Presentation $presentation
  $presentation.Close()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation)
  $presentation = $null

  $presentation = $powerPoint.Presentations.Open($sourceDeck, $false, $false, $false)
  $state1Before = Capture-Presentation $presentation
  $presentation.SaveAs($roundtrip1, 24, -1)
  $presentation.Close()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation)
  $presentation = $null

  $presentation = $powerPoint.Presentations.Open($roundtrip1, $false, $false, $false)
  $state1After = Capture-Presentation $presentation
  $presentation.SaveAs($roundtrip2, 24, -1)
  $presentation.Close()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation)
  $presentation = $null

  $presentation = $powerPoint.Presentations.Open($roundtrip2, $false, $false, $false)
  $state2 = Capture-Presentation $presentation
  $presentation.Close()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation)
  $presentation = $null

  $presentation = $powerPoint.Presentations.Open($roundtrip2, $false, $false, $false)
  $controlRange = $presentation.Slides.Item(1).Shapes.Item('SW-Font-Mixed-Runs').TextFrame2.TextRange.Characters(1, 7)
  $controlRange.Font.Name = $missingFamily
  $presentation.SaveAs($missingControl, 24, -1)
  $missingState = Capture-Presentation $presentation
  $presentation.Close()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation)
  $presentation = $null

  $powerPoint.Quit()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
  $powerPoint = $null

  $json0 = $state0 | ConvertTo-Json -Depth 40 -Compress
  $json1Before = $state1Before | ConvertTo-Json -Depth 40 -Compress
  $json1After = $state1After | ConvertTo-Json -Depth 40 -Compress
  $json2 = $state2 | ConvertTo-Json -Depth 40 -Compress
  $familyFontStates = @($state2.fonts | Where-Object { $_.name -eq $family })
  $valid = ($json0 -eq $json1Before) -and ($json1Before -eq $json1After) -and ($json1After -eq $json2) -and ($state2.slideCount -eq 2) -and ($familyFontStates.Count -ge 1)
  $result = [ordered]@{
    valid = $valid
    application = 'Microsoft PowerPoint'
    family = $family
    missingControlFamily = $missingFamily
    embeddedSaveRequested = $true
    cycles = 2
    sourceSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceDeck).Hash.ToLowerInvariant()
    roundtrip1Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $roundtrip1).Hash.ToLowerInvariant()
    roundtrip2Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $roundtrip2).Hash.ToLowerInvariant()
    missingControlSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $missingControl).Hash.ToLowerInvariant()
    statesEqual = [ordered]@{ sourceToFirstOpen = ($json0 -eq $json1Before); firstToSecondOpen = ($json1Before -eq $json1After); secondToFinalOpen = ($json1After -eq $json2) }
    sourceState = $state0
    finalState = $state2
    missingControlState = $missingState
  }
  $result | ConvertTo-Json -Depth 45 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
  if (-not $valid) { throw 'PowerPoint changed native font state during the C11 round trips.' }
} finally {
  if ($null -ne $presentation) {
    try { $presentation.Close() } catch { }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation)
  }
  if ($null -ne $powerPoint) {
    try { $powerPoint.Quit() } catch { }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  $cleanupItems = @($installed)
  [array]::Reverse($cleanupItems)
  foreach ($item in $cleanupItems) {
    [void][SlidewrightFontNativeMethods]::RemoveFontResourceEx($item.path, 0, [IntPtr]::Zero)
    Remove-ItemProperty -Path $registryPath -Name $item.registryName -ErrorAction SilentlyContinue
    Remove-Item -Force -LiteralPath $item.path -ErrorAction SilentlyContinue
  }
  Broadcast-FontChange
}
