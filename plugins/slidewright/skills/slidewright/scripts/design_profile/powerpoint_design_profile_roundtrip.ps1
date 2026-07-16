param(
    [Parameter(Mandatory = $true)][string]$InputPptx,
    [Parameter(Mandatory = $true)][string]$OutputPptx,
    [Parameter(Mandatory = $true)][string]$ReportJson
)

$ErrorActionPreference = "Stop"
$input = [IO.Path]::GetFullPath($InputPptx)
$output = [IO.Path]::GetFullPath($OutputPptx)
$report = [IO.Path]::GetFullPath($ReportJson)
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($output)) | Out-Null
if (Test-Path -LiteralPath $output) { Remove-Item -Force -LiteralPath $output }

function Invoke-ComRetry([scriptblock]$Action) {
    $lastError = $null
    for ($attempt = 1; $attempt -le 12; $attempt++) {
        try { & $Action; return } catch { $lastError = $_; Start-Sleep -Milliseconds 250 }
    }
    throw $lastError
}

function Shape-State($shape) {
    $text = ""
    $font = ""
    $size = 0
    if ($shape.HasTextFrame -eq -1 -and $shape.TextFrame2.HasText -eq -1) {
        $text = $shape.TextFrame2.TextRange.Text -replace [char]13, [char]10
        $font = $shape.TextFrame2.TextRange.Font.Name
        $size = [double]$shape.TextFrame2.TextRange.Font.Size
    }
    return [ordered]@{
        name = $shape.Name
        type = [int]$shape.Type
        left = [double]$shape.Left
        top = [double]$shape.Top
        width = [double]$shape.Width
        height = [double]$shape.Height
        text = $text
        font = $font
        size = $size
    }
}

function Named-State($shapes, [string[]]$names) {
    $items = @()
    foreach ($name in $names) { $items += Shape-State $shapes.Item($name) }
    return $items
}

function Capture-State($presentation) {
    $guides = @()
    for ($i = 1; $i -le $presentation.Guides.Count; $i++) {
        $guide = $presentation.Guides.Item($i)
        $guides += [ordered]@{ orientation = [int]$guide.Orientation; position = [double]$guide.Position }
    }
    $master = $presentation.SlideMaster
    $logo = $master.Shapes.Item("SW Logo Group")
    $members = @()
    for ($i = 1; $i -le $logo.GroupItems.Count; $i++) { $members += $logo.GroupItems.Item($i).Name }
    $slide1 = $presentation.Slides.Item(1)
    $slide2 = $presentation.Slides.Item(2)
    return [ordered]@{
        slideWidth = [double]$presentation.PageSetup.SlideWidth
        slideHeight = [double]$presentation.PageSetup.SlideHeight
        guides = $guides
        layoutNames = @($slide1.CustomLayout.Name, $slide2.CustomLayout.Name)
        masterRails = Named-State $master.Shapes @("SW Rail Left", "SW Rail Right", "SW Rail Top", "SW Rail Bottom")
        contentLimiters = Named-State $slide1.CustomLayout.Shapes @("SW Limiter Left", "SW Limiter Right")
        sectionLimiters = Named-State $slide2.CustomLayout.Shapes @("SW Section Limiter Left", "SW Section Limiter Right", "SW Declared Asymmetric Accent", "SW Declared Rule Left", "SW Declared Rule Right")
        logo = [ordered]@{ name = $logo.Name; type = [int]$logo.Type; members = $members }
        slide1 = Named-State $slide1.Shapes @("SW Content Title", "SW Content Body")
        slide2 = Named-State $slide2.Shapes @("SW Section Title", "SW Section Body")
        footer = $slide1.HeadersFooters.Footer.Text
        footerVisible = [bool]$slide1.HeadersFooters.Footer.Visible
        slideNumberVisible = [bool]$slide1.HeadersFooters.SlideNumber.Visible
    }
}


function Open-PresentationWithRetry($Application, [string]$FilePath, [bool]$ReadOnly) {
    $lastError = $null
    for ($attempt = 1; $attempt -le 80; $attempt++) {
        try { return $Application.Presentations.Open($FilePath, $ReadOnly, $false, $false) }
        catch { $lastError = $_; Start-Sleep -Milliseconds 250 }
    }
    throw $lastError
}

function Capture-StateWithRetry($Presentation) {
    $lastError = $null
    for ($attempt = 1; $attempt -le 40; $attempt++) {
        try { return Capture-State $Presentation }
        catch { $lastError = $_; Start-Sleep -Milliseconds 250 }
    }
    throw $lastError
}

function Save-PresentationWithRetry($Presentation, [string]$FilePath) {
    $lastError = $null
    for ($attempt = 1; $attempt -le 40; $attempt++) {
        try { $Presentation.SaveAs($FilePath, 24); return }
        catch { $lastError = $_; Start-Sleep -Milliseconds 250 }
    }
    throw $lastError
}

function Close-PresentationWithRetry($Presentation) {
    $lastError = $null
    for ($attempt = 1; $attempt -le 40; $attempt++) {
        try { $Presentation.Close(); return }
        catch { $lastError = $_; Start-Sleep -Milliseconds 250 }
    }
    throw $lastError
}

function Quit-PowerPointWithRetry($Application) {
    $lastError = $null
    for ($attempt = 1; $attempt -le 40; $attempt++) {
        try { $Application.Quit(); return }
        catch { $lastError = $_; Start-Sleep -Milliseconds 250 }
    }
    throw $lastError
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SlidewrightNativeMethods {
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

Start-Sleep -Milliseconds 1500
$existingPowerPointIds = @((Get-Process POWERPNT -ErrorAction SilentlyContinue).Id)
$powerPoint = $null
$presentation = $null
$createdPowerPointProcess = $null
$ownedPowerPointStartTime = $null
$sharedPowerPointStartTime = $null
$ownsPowerPointProcess = $false
$sharedPowerPointProcess = $false
try {
    $powerPoint = New-Object -ComObject PowerPoint.Application
    if (-not $powerPoint) { throw "PowerPoint COM application could not be created." }
    $script:powerPointApp = $powerPoint
    $script:inputPptxPath = $input
    $script:outputPptxPath = $output
    Start-Sleep -Milliseconds 1000
    [uint32]$ownedPowerPointId = 0
    $powerPointHwnd = [IntPtr]([long]$powerPoint.HWND)
    [void][SlidewrightNativeMethods]::GetWindowThreadProcessId($powerPointHwnd, [ref]$ownedPowerPointId)
    if ($ownedPowerPointId -eq 0) { throw "Could not resolve the PowerPoint COM window to a process." }
    $resolvedPowerPointProcess = Get-Process -Id ([int]$ownedPowerPointId) -ErrorAction Stop
    if ($existingPowerPointIds -contains [int]$ownedPowerPointId) {
        $sharedPowerPointProcess = $true
        $sharedPowerPointStartTime = $resolvedPowerPointProcess.StartTime
    } else {
        $ownsPowerPointProcess = $true
        $createdPowerPointProcess = $resolvedPowerPointProcess
        $ownedPowerPointStartTime = $createdPowerPointProcess.StartTime
    }
    $presentation = Open-PresentationWithRetry $powerPoint $input $false
    $before = Capture-StateWithRetry $presentation
    Save-PresentationWithRetry $presentation $output
    Close-PresentationWithRetry $presentation
    $presentation = $null
    $presentation = Open-PresentationWithRetry $powerPoint $output $true
    $after = Capture-StateWithRetry $presentation
    Close-PresentationWithRetry $presentation
    $presentation = $null

    $inputSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $input).Hash.ToLowerInvariant()
    $outputSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $output).Hash.ToLowerInvariant()
    $serialized = $inputSha256 -ne $outputSha256
    $valid = $serialized -and (($before | ConvertTo-Json -Depth 12 -Compress) -eq ($after | ConvertTo-Json -Depth 12 -Compress))
    $valid = $valid -and ($after.slideWidth -eq 960) -and ($after.slideHeight -eq 540)
    $valid = $valid -and ($after.guides.Count -eq 4)
    $valid = $valid -and ($after.logo.type -eq 6) -and ($after.logo.members.Count -eq 2)
    $valid = $valid -and ($after.sectionLimiters[3].width -eq 3) -and ($after.sectionLimiters[4].width -eq 5)
    $sharedProcessPreserved = $true
    if ($sharedPowerPointProcess) {
        $sharedProcessAfter = Get-Process -Id ([int]$ownedPowerPointId) -ErrorAction SilentlyContinue
        $sharedProcessPreserved = $null -ne $sharedProcessAfter -and $sharedProcessAfter.StartTime -eq $sharedPowerPointStartTime
        $valid = $valid -and $sharedProcessPreserved
    }
    $valid = $valid -and ($after.slide1[0].text -eq "Launch readiness review")
    $valid = $valid -and ($after.slide1[1].text -eq ("Three workstreams" + [char]10 + "One release owner" + [char]10 + "A go or no-go Friday"))
    $valid = $valid -and $after.footerVisible -and $after.slideNumberVisible
    $result = [ordered]@{
        valid = $valid
        application = "Microsoft PowerPoint"
        serializedBySaveAs = $serialized
        automationProcessOwned = $ownsPowerPointProcess
        sharedProcessPreserved = $sharedProcessPreserved
        inputSha256 = $inputSha256
        outputSha256 = $outputSha256
        beforeSave = $before
        afterReopen = $after
    }
    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($report)) | Out-Null
    $result | ConvertTo-Json -Depth 15 | Set-Content -Encoding UTF8 -LiteralPath $report
    $result | ConvertTo-Json -Depth 15
    if (-not $valid) { exit 1 }
} finally {
    if ($presentation) { try { $script:presentation.Close() } catch { } }
    if ($powerPoint) {
        if ($ownsPowerPointProcess) {
            try { Quit-PowerPointWithRetry $powerPoint } catch {
                Write-Warning ("PowerPoint quit retry exhausted: " + $_.Exception.Message)
                $ownedProcess = Get-Process -Id $createdPowerPointProcess.Id -ErrorAction SilentlyContinue
                if ($ownedProcess -and $ownedProcess.StartTime -eq $ownedPowerPointStartTime) {
                    Stop-Process -Id $ownedProcess.Id -Force -ErrorAction SilentlyContinue
                }
            }
        }
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
