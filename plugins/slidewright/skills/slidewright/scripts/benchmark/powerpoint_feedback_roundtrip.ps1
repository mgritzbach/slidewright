param(
    [Parameter(Mandatory = $true)][string]$InputPptx,
    [Parameter(Mandatory = $true)][string]$OutputPptx,
    [Parameter(Mandatory = $true)][string]$PlanJson,
    [Parameter(Mandatory = $true)][string]$ReportJson
)

$ErrorActionPreference = "Stop"
$inputPath = [IO.Path]::GetFullPath($InputPptx)
$outputPath = [IO.Path]::GetFullPath($OutputPptx)
$planPath = [IO.Path]::GetFullPath($PlanJson)
$reportPath = [IO.Path]::GetFullPath($ReportJson)
$plan = Get-Content -Raw -LiteralPath $planPath | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($outputPath)) | Out-Null
if (Test-Path -LiteralPath $outputPath) { Remove-Item -Force -LiteralPath $outputPath }

function Retry([scriptblock]$Action, [int]$Attempts = 40) {
    $lastError = $null
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try { return & $Action } catch { $lastError = $_; Start-Sleep -Milliseconds 250 }
    }
    throw $lastError
}

function Shape-State($shape) {
    $text = ""
    $paragraphs = 0
    $emptyParagraphs = 0
    $hasText = $shape.HasTextFrame -eq -1 -and $shape.TextFrame2.HasText -eq -1
    if ($hasText) {
        $text = [string]$shape.TextFrame2.TextRange.Text -replace [char]13, [char]10
        $paragraphs = [int]$shape.TextFrame2.TextRange.Paragraphs().Count
        for ($index = 1; $index -le $paragraphs; $index++) {
            $paragraph = [string]$shape.TextFrame2.TextRange.Paragraphs($index, 1).Text
            if (($paragraph -replace [char]13, "").Trim().Length -eq 0) { $emptyParagraphs++ }
        }
    }
    return [ordered]@{
        name = [string]$shape.Name
        type = [int]$shape.Type
        left = [double]$shape.Left
        top = [double]$shape.Top
        width = [double]$shape.Width
        height = [double]$shape.Height
        hasText = [bool]$hasText
        text = $text
        paragraphs = $paragraphs
        emptyParagraphs = $emptyParagraphs
    }
}

function Capture-State($presentation) {
    $slides = @()
    $nativeText = 0
    $emptyParagraphs = 0
    for ($slideIndex = 1; $slideIndex -le $presentation.Slides.Count; $slideIndex++) {
        $slide = $presentation.Slides.Item($slideIndex)
        $shapes = @()
        for ($shapeIndex = 1; $shapeIndex -le $slide.Shapes.Count; $shapeIndex++) {
            $state = Shape-State $slide.Shapes.Item($shapeIndex)
            if ($state.hasText) { $nativeText++ }
            $emptyParagraphs += $state.emptyParagraphs
            $shapes += $state
        }
        $slides += [ordered]@{ index = $slideIndex; shapes = $shapes }
    }
    return [ordered]@{
        slideWidth = [double]$presentation.PageSetup.SlideWidth
        slideHeight = [double]$presentation.PageSetup.SlideHeight
        slideCount = [int]$presentation.Slides.Count
        nativeTextShapes = $nativeText
        emptyParagraphs = $emptyParagraphs
        slides = $slides
    }
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SlidewrightFeedbackNativeMethods {
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostThreadMessage(uint threadId, uint message, IntPtr wParam, IntPtr lParam);
}
"@

$workerStartedUtc = (Get-Date).ToUniversalTime()
$existingIds = @((Get-Process POWERPNT -ErrorAction SilentlyContinue).Id)
$powerPoint = $null
$presentation = $null
$ownedProcess = $null
$ownedStart = $null
$startupCandidate = $null
$sharedStart = $null
$ownsProcess = $false
$sharedProcess = $false

function Find-NewHeadlessAutomationPowerPoint {
    $candidates = @()
    foreach ($processInfo in @(Get-CimInstance Win32_Process -Filter "Name = 'POWERPNT.EXE'" -ErrorAction SilentlyContinue)) {
        if ($existingIds -contains [int]$processInfo.ProcessId) { continue }
        if ([string]$processInfo.CommandLine -notmatch '(?i)(?:^|\s)/AUTOMATION(?:\s|$)') { continue }
        $process = Get-Process -Id ([int]$processInfo.ProcessId) -ErrorAction SilentlyContinue
        if (-not $process -or $process.MainWindowHandle -ne 0 -or $process.StartTime.ToUniversalTime() -lt $workerStartedUtc.AddSeconds(-2)) { continue }
        $candidates += $process
    }
    if ($candidates.Count -eq 1) { return $candidates[0] }
    return $null
}

function New-PowerPointApplicationWithRetry([int]$Attempts = 6) {
    $lastError = $null
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try { return New-Object -ComObject PowerPoint.Application } catch {
            $lastError = $_
            $candidate = Find-NewHeadlessAutomationPowerPoint
            if ($candidate) { $script:startupCandidate = $candidate }
            if ($attempt -lt $Attempts) { Start-Sleep -Milliseconds (500 * $attempt) }
        }
    }
    throw $lastError
}

function Request-ExactHeadlessExit($Process, $ExpectedStart) {
    if (-not $Process -or -not $ExpectedStart) { return $true }
    $live = Get-Process -Id ([int]$Process.Id) -ErrorAction SilentlyContinue
    if (-not $live) { return $true }
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($live.Id)" -ErrorAction SilentlyContinue
    if (-not $processInfo -or [string]$live.ProcessName -ne 'POWERPNT' -or $live.StartTime -ne $ExpectedStart -or
        $live.MainWindowHandle -ne 0 -or [string]$processInfo.CommandLine -notmatch '(?i)(?:^|\s)/AUTOMATION(?:\s|$)') { return $false }
    foreach ($thread in @($live.Threads)) {
        [void][SlidewrightFeedbackNativeMethods]::PostThreadMessage([uint32]$thread.Id, 0x0012, [IntPtr]::Zero, [IntPtr]::Zero)
    }
    return $live.WaitForExit(45000)
}

try {
    $powerPoint = New-PowerPointApplicationWithRetry
    if (-not $powerPoint) { throw "PowerPoint COM application could not be created." }
    Start-Sleep -Milliseconds 1000
    [uint32]$processId = 0
    [void][SlidewrightFeedbackNativeMethods]::GetWindowThreadProcessId([IntPtr]([long]$powerPoint.HWND), [ref]$processId)
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

    $expectedText = 0
    foreach ($slide in $plan.slides) { foreach ($shape in $slide.shapes) { if ($shape.type -eq "text") { $expectedText++ } } }
    $inputHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $inputPath).Hash.ToLowerInvariant()
    $outputHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash.ToLowerInvariant()
    $serialized = $inputHash -ne $outputHash
    $statePreserved = ($before | ConvertTo-Json -Depth 20 -Compress) -eq ($after | ConvertTo-Json -Depth 20 -Compress)
    $sharedPreserved = $true
    if ($sharedProcess) {
        $sharedAfter = Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue
        $sharedPreserved = $null -ne $sharedAfter -and $sharedAfter.StartTime -eq $sharedStart
    }
    $valid = $serialized -and $statePreserved -and $sharedPreserved -and $after.slideCount -eq $plan.slides.Count -and $after.nativeTextShapes -eq $expectedText -and $after.emptyParagraphs -eq 0
    $result = [ordered]@{
        valid = $valid
        application = "Microsoft PowerPoint"
        serializedBySaveAs = $serialized
        exactStatePreserved = $statePreserved
        automationProcessOwned = $ownsProcess
        sharedProcessPreserved = $sharedPreserved
        expectedSlides = $plan.slides.Count
        expectedNativeTextShapes = $expectedText
        inputSha256 = $inputHash
        outputSha256 = $outputHash
        beforeSave = $before
        afterReopen = $after
    }
    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($reportPath)) | Out-Null
    $result | ConvertTo-Json -Depth 25 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
    $result | ConvertTo-Json -Depth 5
    if (-not $valid) { exit 1 }
} finally {
    if ($presentation) { try { $presentation.Close() } catch { } }
    if ($powerPoint) {
        if ($ownsProcess) {
            try { Retry { $powerPoint.Quit() } 8 | Out-Null } catch { }
        }
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
        $powerPoint = $null
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    if ($ownsProcess -and -not (Request-ExactHeadlessExit $ownedProcess $ownedStart)) {
        throw "Owned PowerPoint process did not exit after safe exact-identity cleanup."
    }
    if ($startupCandidate -and (-not $ownedProcess -or $startupCandidate.Id -ne $ownedProcess.Id) -and
        -not (Request-ExactHeadlessExit $startupCandidate $startupCandidate.StartTime)) {
        throw "Transient PowerPoint startup process did not exit after safe exact-identity cleanup."
    }
}
