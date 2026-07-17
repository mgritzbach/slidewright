param(
  [Parameter(Mandatory = $true)][string]$OwnershipRecordJson,
  [int]$HoldSeconds = 120,
  [string]$WorkerIntentJson = '',
  [string]$ReadyMarker = ''
)

$ErrorActionPreference = 'Stop'
$workerIntentPath = if ($WorkerIntentJson) { [IO.Path]::GetFullPath($WorkerIntentJson) } else { '' }
if ($workerIntentPath) {
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($workerIntentPath)) | Out-Null
  $workerProcess = Get-Process -Id $PID -ErrorAction Stop
  $intent = [ordered]@{
    schemaVersion = 'slidewright-worker-intent/v1'
    workerProcessId = [int]$PID
    workerProcessName = [string]$workerProcess.ProcessName
    workerProcessStartTime = $workerProcess.StartTime.ToUniversalTime().ToString('o')
    purpose = 'timeout-cleanup-negative-control'
    state = 'started'
    ownershipRecordPath = [IO.Path]::GetFullPath($OwnershipRecordJson)
  }
  $intentTemporary = "$workerIntentPath.tmp-$PID"
  $intent | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $intentTemporary
  Move-Item -Force -LiteralPath $intentTemporary -Destination $workerIntentPath
}
$ownershipPath = [IO.Path]::GetFullPath($OwnershipRecordJson)
$readyPath = if ($ReadyMarker) { [IO.Path]::GetFullPath($ReadyMarker) } else { '' }
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($ownershipPath)) | Out-Null
if (Test-Path -LiteralPath $ownershipPath) { Remove-Item -Force -LiteralPath $ownershipPath }
if ($readyPath) {
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($readyPath)) | Out-Null
  if (Test-Path -LiteralPath $readyPath) { Remove-Item -Force -LiteralPath $readyPath }
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SlidewrightTimeoutProbeNativeMethods {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

$existingIds = @((Get-Process POWERPNT -ErrorAction SilentlyContinue) | ForEach-Object { [int]$_.Id })
if ($existingIds.Count -gt 0) {
  throw 'Timeout probe requires PowerPoint to be fully closed before COM creation; refusing to attach to an existing user session.'
}
$powerPoint = $null
$ownedProcess = $null
$ownedStart = $null
$ownsProcess = $false

function Test-EmptyPresentationInventory($Application) {
  $firstCount = [int]$Application.Presentations.Count
  $firstVisible = [int]$Application.Visible -ne 0
  Start-Sleep -Milliseconds 150
  $secondCount = [int]$Application.Presentations.Count
  $secondVisible = [int]$Application.Visible -ne 0
  return $firstCount -eq 0 -and $secondCount -eq 0 -and -not $firstVisible -and -not $secondVisible
}

try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  if (-not $powerPoint) { throw 'PowerPoint COM application could not be created.' }
  Start-Sleep -Milliseconds 750

  [uint32]$resolvedProcessId = 0
  [void][SlidewrightTimeoutProbeNativeMethods]::GetWindowThreadProcessId([IntPtr]([long]$powerPoint.HWND), [ref]$resolvedProcessId)
  $processId = [int]$resolvedProcessId
  if ($processId -eq 0) { throw 'Could not resolve the timeout-probe PowerPoint process from its application window.' }
  if ($existingIds -contains $processId) { throw 'Timeout probe attached to a process that existed before COM creation.' }

  $resolved = Get-Process -Id $processId -ErrorAction Stop
  if ($resolved.ProcessName -ne 'POWERPNT') { throw "Resolved process $processId is not PowerPoint." }
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
  if ([string]$processInfo.CommandLine -notmatch '(?i)(?:^|\s)/AUTOMATION(?:\s|$)') {
    throw 'Resolved PowerPoint process is not an Office automation process; refusing ownership.'
  }
  if (-not (Test-EmptyPresentationInventory $powerPoint)) {
    throw 'Resolved PowerPoint process is not empty and hidden; refusing ownership.'
  }

  $ownedProcess = $resolved
  $ownedStart = $ownedProcess.StartTime
  $ownsProcess = $true
  $powerPointBuild = $null
  try { $powerPointBuild = [string]$powerPoint.Build } catch { $powerPointBuild = $null }
  $record = [ordered]@{
    schemaVersion = 'slidewright-owned-powerpoint/v1'
    processName = 'POWERPNT'
    processId = [int]$ownedProcess.Id
    processStartTime = $ownedStart.ToUniversalTime().ToString('o')
    workerProcessId = [int]$PID
    workerProcessName = [string](Get-Process -Id $PID -ErrorAction Stop).ProcessName
    workerProcessStartTime = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')
    purpose = 'timeout-cleanup-negative-control'
    version = [string]$powerPoint.Version
    build = $powerPointBuild
    expectedApplicationVisible = $false
    ownedPresentationPaths = @()
  }
  $temporary = "$ownershipPath.tmp"
  $record | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $temporary
  Move-Item -Force -LiteralPath $temporary -Destination $ownershipPath
  if ($readyPath) {
    $readyTemporary = "$readyPath.tmp-$PID"
    Set-Content -Encoding UTF8 -LiteralPath $readyTemporary -Value 'ready'
    Move-Item -Force -LiteralPath $readyTemporary -Destination $readyPath
  }
  Start-Sleep -Seconds $HoldSeconds
  throw 'Timeout probe was not terminated by the runner.'
} finally {
  $cleanupError = $null
  if ($powerPoint) {
    if ($ownsProcess) {
      if (-not (Test-EmptyPresentationInventory $powerPoint)) {
        $cleanupError = 'Timeout probe cleanup refused because the owned automation process became visible or gained a presentation.'
      }
    }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  if ($ownsProcess -and -not $cleanupError) {
    $ownedExited = $ownedProcess.WaitForExit(45000)
    if (-not $ownedExited) { $cleanupError = "Owned PowerPoint process $($ownedProcess.Id) did not exit naturally after COM release." }
  }
  if ($cleanupError) { throw $cleanupError }
}
