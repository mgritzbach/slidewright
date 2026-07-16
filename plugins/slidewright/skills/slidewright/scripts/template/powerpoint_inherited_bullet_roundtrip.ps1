param(
    [Parameter(Mandatory = $true)][string]$InputPptx,
    [Parameter(Mandatory = $true)][string]$OutputPptx,
    [Parameter(Mandatory = $true)][string]$ReportJson
)

$ErrorActionPreference = "Stop"
$inputPath = [IO.Path]::GetFullPath($InputPptx)
$outputPath = [IO.Path]::GetFullPath($OutputPptx)
$reportPath = [IO.Path]::GetFullPath($ReportJson)
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($outputPath)) | Out-Null
if (Test-Path -LiteralPath $outputPath) { Remove-Item -Force -LiteralPath $outputPath }

function Retry([scriptblock]$Action, [int]$Attempts = 40) {
    $lastError = $null
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try { return & $Action } catch { $lastError = $_; Start-Sleep -Milliseconds 250 }
    }
    throw $lastError
}

function Capture-State($presentation) {
    $body = $presentation.Slides.Item(1).Shapes.Item("MIT Fixture Body")
    $range = $body.TextFrame2.TextRange
    $paragraphs = @()
    $empty = 0
    for ($index = 1; $index -le $range.Paragraphs().Count; $index++) {
        $paragraph = $range.Paragraphs($index, 1)
        $text = ([string]$paragraph.Text -replace [char]13, "").Trim()
        if ($text.Length -eq 0) { $empty++ }
        $paragraphs += [ordered]@{
            text = $text
            bulletVisible = [int]$paragraph.ParagraphFormat.Bullet.Visible
            bulletType = [int]$paragraph.ParagraphFormat.Bullet.Type
            level = [int]$paragraph.ParagraphFormat.Bullet.RelativeSize
        }
    }
    return [ordered]@{
        slideCount = [int]$presentation.Slides.Count
        layoutName = [string]$presentation.Slides.Item(1).CustomLayout.Name
        bodyShapeType = [int]$body.Type
        bodyLeft = [double]$body.Left
        bodyTop = [double]$body.Top
        bodyWidth = [double]$body.Width
        bodyHeight = [double]$body.Height
        paragraphCount = [int]$paragraphs.Count
        emptyParagraphs = $empty
        paragraphs = $paragraphs
        preserveTitle = [string]$presentation.Slides.Item(2).Shapes.Item("MIT Preserve Title").TextFrame2.TextRange.Text
        preserveBody = [string]$presentation.Slides.Item(2).Shapes.Item("MIT Preserve Body").TextFrame2.TextRange.Text
    }
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SlidewrightInheritedBulletNativeMethods {
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

$existingIds = @((Get-Process POWERPNT -ErrorAction SilentlyContinue).Id)
$powerPoint = $null
$presentation = $null
$ownedProcess = $null
$ownedStart = $null
$sharedStart = $null
$ownsProcess = $false
$sharedProcess = $false
try {
    $powerPoint = New-Object -ComObject PowerPoint.Application
    Start-Sleep -Milliseconds 1000
    [uint32]$processId = 0
    [void][SlidewrightInheritedBulletNativeMethods]::GetWindowThreadProcessId([IntPtr]([long]$powerPoint.HWND), [ref]$processId)
    if ($processId -eq 0) { throw "Could not resolve the PowerPoint COM process." }
    $resolved = Get-Process -Id ([int]$processId) -ErrorAction Stop
    if ($existingIds -contains [int]$processId) { $sharedProcess = $true; $sharedStart = $resolved.StartTime }
    else { $ownsProcess = $true; $ownedProcess = $resolved; $ownedStart = $resolved.StartTime }

    $presentation = Retry { $powerPoint.Presentations.Open($inputPath, $false, $false, $false) } 80
    $before = Retry { Capture-State $presentation }
    Retry { $presentation.SaveAs($outputPath, 24) } | Out-Null
    Retry { $presentation.Close() } | Out-Null
    $presentation = $null
    $presentation = Retry { $powerPoint.Presentations.Open($outputPath, $true, $false, $false) } 80
    $after = Retry { Capture-State $presentation }
    Retry { $presentation.Close() } | Out-Null
    $presentation = $null

    $expectedText = @("Three priorities", "One accountable owner", "A decision by Friday")
    $actualText = @($after.paragraphs | ForEach-Object { $_.text })
    $bulletsVisible = @($after.paragraphs | ForEach-Object { $_.bulletVisible -eq -1 }) -notcontains $false
    $inputHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $inputPath).Hash.ToLowerInvariant()
    $outputHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash.ToLowerInvariant()
    $serialized = $inputHash -ne $outputHash
    $statePreserved = ($before | ConvertTo-Json -Depth 12 -Compress) -eq ($after | ConvertTo-Json -Depth 12 -Compress)
    $sharedPreserved = $true
    if ($sharedProcess) {
        $sharedAfter = Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue
        $sharedPreserved = $null -ne $sharedAfter -and $sharedAfter.StartTime -eq $sharedStart
    }
    $valid = $serialized -and $statePreserved -and $sharedPreserved -and
        $after.slideCount -eq 2 -and $after.paragraphCount -eq 3 -and $after.emptyParagraphs -eq 0 -and
        (($actualText | ConvertTo-Json -Compress) -eq ($expectedText | ConvertTo-Json -Compress)) -and
        $bulletsVisible -and $after.preserveTitle -eq "Preserve-only control" -and
        $after.preserveBody -eq "This slide must remain unchanged."
    $result = [ordered]@{
        valid = $valid
        application = "Microsoft PowerPoint"
        serializedBySaveAs = $serialized
        exactStatePreserved = $statePreserved
        automationProcessOwned = $ownsProcess
        sharedProcessPreserved = $sharedPreserved
        nativeEditablePlaceholder = $after.bodyShapeType -eq 14
        inheritedBulletsVisible = $bulletsVisible
        inputSha256 = $inputHash
        outputSha256 = $outputHash
        beforeSave = $before
        afterReopen = $after
    }
    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($reportPath)) | Out-Null
    $result | ConvertTo-Json -Depth 15 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
    $result | ConvertTo-Json -Depth 6
    if (-not $valid) { exit 1 }
} finally {
    if ($presentation) { try { $presentation.Close() } catch { } }
    if ($powerPoint) {
        if ($ownsProcess) {
            try { Retry { $powerPoint.Quit() } | Out-Null } catch {
                $process = Get-Process -Id $ownedProcess.Id -ErrorAction SilentlyContinue
                if ($process -and $process.StartTime -eq $ownedStart) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
            }
        }
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
