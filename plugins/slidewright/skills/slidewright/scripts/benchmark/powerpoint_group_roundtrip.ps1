param(
  [Parameter(Mandatory = $true)][string]$InputPptx,
  [Parameter(Mandatory = $true)][string]$OutputPptx,
  [Parameter(Mandatory = $true)][string]$ReportJson
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $InputPptx).Path
$target = [System.IO.Path]::GetFullPath($OutputPptx)
$reportPath = [System.IO.Path]::GetFullPath($ReportJson)
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($target)) | Out-Null
[System.IO.File]::Copy($source, $target, $true)

$powerPoint = $null
$presentation = $null
$reopened = $null
try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $presentation = $powerPoint.Presentations.Open($target, $false, $false, $false)
  $slide = $presentation.Slides.Item(1)
  $group = $null
  foreach ($shape in $slide.Shapes) {
    if ($shape.Type -eq 6) { $group = $shape; break }
  }
  if ($null -eq $group) { throw 'No native PowerPoint group found on slide 1.' }
  $beforeCount = $group.GroupItems.Count
  $members = $group.Ungroup()
  if ($members.Count -ne $beforeCount) { throw "Ungroup changed the child count: $beforeCount to $($members.Count)." }
  $regrouped = $members.Group()
  $regrouped.Name = 'slidewright-roundtrip-proof'
  $presentation.Save()
  $presentation.Close()
  $presentation = $null

  $reopened = $powerPoint.Presentations.Open($target, $true, $false, $false)
  $proof = $reopened.Slides.Item(1).Shapes.Item('slidewright-roundtrip-proof')
  $afterCount = $proof.GroupItems.Count
  if ($afterCount -ne $beforeCount) { throw "Regroup did not preserve the child count: $beforeCount to $afterCount." }
  $nativeTextItems = 0
  foreach ($member in $proof.GroupItems) {
    if ($member.HasTextFrame -and $member.TextFrame.HasText) { $nativeTextItems++ }
  }
  if ($nativeTextItems -lt 1) { throw 'No native editable text survived the ungroup/regroup round trip.' }
  $result = [ordered]@{
    valid = $true
    application = 'Microsoft PowerPoint'
    slide = 1
    childCountBefore = $beforeCount
    childCountAfter = $afterCount
    nativeTextItemsAfter = $nativeTextItems
    groupNameAfter = $proof.Name
  }
  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($reportPath)) | Out-Null
  $result | ConvertTo-Json | Set-Content -LiteralPath $reportPath -Encoding UTF8
  $result | ConvertTo-Json
} finally {
  if ($null -ne $reopened) { $reopened.Close() }
  if ($null -ne $presentation) { $presentation.Close() }
  if ($null -ne $powerPoint) { $powerPoint.Quit() }
  foreach ($item in @($proof, $regrouped, $members, $group, $slide, $reopened, $presentation, $powerPoint)) {
    if ($null -ne $item -and [System.Runtime.InteropServices.Marshal]::IsComObject($item)) {
      [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($item)
    }
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
