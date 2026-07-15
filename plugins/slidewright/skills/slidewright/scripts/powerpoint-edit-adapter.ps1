param(
    [Parameter(Mandatory = $true)][string]$InputPptx,
    [Parameter(Mandatory = $true)][string]$OutputPptx,
    [Parameter(Mandatory = $true)][string]$ReportJson,
    [string]$GroupName = "invite-landscape-editable",
    [string]$TargetName = "invite-h-subtitle",
    [string]$ReplacementText = "EDITABLE IN POWERPOINT"
)

$ErrorActionPreference = "Stop"
$source = (Resolve-Path -LiteralPath $InputPptx).Path
$target = [System.IO.Path]::GetFullPath($OutputPptx)
$report = [System.IO.Path]::GetFullPath($ReportJson)
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
[System.IO.File]::Copy($source, $target, $true)
$inputHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()

$powerPoint = $null
$presentation = $null
$reopened = $null
$slide = $null
$group = $null
$members = $null
$targetShape = $null
$regrouped = $null
$proof = $null
$proofTarget = $null
try {
    $powerPoint = New-Object -ComObject PowerPoint.Application
    $presentation = $powerPoint.Presentations.Open($target, $false, $false, $true)
    if ($null -ne $powerPoint.ActiveWindow) { $powerPoint.ActiveWindow.WindowState = 2 }
    $slide = $presentation.Slides.Item(1)
    $group = $slide.Shapes.Item($GroupName)
    if ($group.Type -ne 6) { throw "Named object '$GroupName' is not a native PowerPoint group." }
    $beforeCount = $group.GroupItems.Count
    $memberNamesBefore = @(
        for ($index = 1; $index -le $beforeCount; $index++) {
            [string]$group.GroupItems.Item($index).Name
        }
    ) | Sort-Object
    $members = $group.Ungroup()
    if ($members.Count -ne $beforeCount) { throw "Ungroup changed child count from $beforeCount to $($members.Count)." }
    foreach ($member in $members) {
        if ($member.Name -eq $TargetName) { $targetShape = $member; break }
    }
    if ($null -eq $targetShape) { throw "Named editable object '$TargetName' was not found after ungrouping." }
    $targetShape.Select()
    $selection = $powerPoint.ActiveWindow.Selection
    if ($selection.Type -ne 2 -or $selection.ShapeRange.Count -ne 1) { throw "PowerPoint did not select exactly one shape." }
    $selectedName = $selection.ShapeRange.Item(1).Name
    if ($selectedName -ne $TargetName) { throw "PowerPoint selected '$selectedName' instead of '$TargetName'." }
    $beforeText = $targetShape.TextFrame2.TextRange.Text
    $beforeBold = [int]$targetShape.TextFrame2.TextRange.Font.Bold
    $targetShape.TextFrame2.TextRange.Text = $ReplacementText
    $targetShape.TextFrame2.TextRange.Font.Bold = -1
    $regrouped = $members.Group()
    $regrouped.Name = $GroupName
    $presentation.Save()
    $presentation.Close()
    $presentation = $null

    $reopened = $powerPoint.Presentations.Open($target, $true, $false, $false)
    $proof = $reopened.Slides.Item(1).Shapes.Item($GroupName)
    $proofTarget = $proof.GroupItems.Item($TargetName)
    $afterText = $proofTarget.TextFrame2.TextRange.Text
    $afterBold = [int]$proofTarget.TextFrame2.TextRange.Font.Bold
    $afterCount = $proof.GroupItems.Count
    $afterGroupName = $proof.Name
    $memberNamesAfter = @(
        for ($index = 1; $index -le $afterCount; $index++) {
            [string]$proof.GroupItems.Item($index).Name
        }
    ) | Sort-Object
    if ($afterCount -ne $beforeCount) { throw "Regroup changed child count from $beforeCount to $afterCount." }
    if ($afterGroupName -ne $GroupName) { throw "Regroup changed the group name from '$GroupName' to '$afterGroupName'." }
    if ((Compare-Object -ReferenceObject $memberNamesBefore -DifferenceObject $memberNamesAfter).Count -ne 0) {
        throw "Regroup changed the exact group member-name set."
    }
    if ($afterText -ne $ReplacementText) { throw "Saved text edit was not retained after reopen." }
    if ($afterBold -ne -1) { throw "Saved bold edit was not retained after reopen." }
    $reopened.Close()
    $reopened = $null
    $outputHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($outputHash -eq $inputHash) { throw "PowerPoint edit did not change the file hash." }

    $result = [ordered]@{
        valid = $true
        application = "Microsoft PowerPoint"
        version = $powerPoint.Version
        slide = 1
        selectedObject = $selectedName
        selectionVerified = $true
        editedObject = $TargetName
        beforeText = $beforeText
        afterText = $afterText
        beforeBold = $beforeBold
        afterBold = $afterBold
        groupNameBefore = $GroupName
        groupNameAfter = $afterGroupName
        childCountBefore = $beforeCount
        childCountAfter = $afterCount
        memberNamesBefore = $memberNamesBefore
        memberNamesAfter = $memberNamesAfter
        exactMemberSetPreserved = $true
        inputSha256 = $inputHash
        outputSha256 = $outputHash
    }
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($report)) | Out-Null
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $report -Encoding UTF8
    $result | ConvertTo-Json -Depth 6
} finally {
    if ($null -ne $reopened) { $reopened.Close() }
    if ($null -ne $presentation) { $presentation.Close() }
    if ($null -ne $powerPoint) { $powerPoint.Quit() }
    foreach ($item in @($proofTarget, $proof, $regrouped, $targetShape, $members, $group, $slide, $reopened, $presentation, $powerPoint)) {
        if ($null -ne $item -and [System.Runtime.InteropServices.Marshal]::IsComObject($item)) {
            [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($item)
        }
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
