param(
  [Parameter(Mandatory = $true)][string]$OwnershipRecordJson,
  [Parameter(Mandatory = $true)][string]$StopMarker,
  [Parameter(Mandatory = $true)][string]$ReadyMarker,
  [Parameter(Mandatory = $true)][string]$ArmedMarker,
  [Parameter(Mandatory = $true)][string]$ReportJson,
  [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
$ownershipPath = [IO.Path]::GetFullPath($OwnershipRecordJson)
$stopPath = [IO.Path]::GetFullPath($StopMarker)
$readyPath = [IO.Path]::GetFullPath($ReadyMarker)
$armedPath = [IO.Path]::GetFullPath($ArmedMarker)
$reportPath = [IO.Path]::GetFullPath($ReportJson)
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($reportPath)) | Out-Null

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SlidewrightWindowProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  public static List<string[]> VisibleWindows(uint expectedPid) {
    var result = new List<string[]>();
    EnumWindows((hWnd, lParam) => {
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      if (pid == expectedPid && IsWindowVisible(hWnd)) {
        var title = new StringBuilder(1024); GetWindowText(hWnd, title, title.Capacity);
        var cls = new StringBuilder(256); GetClassName(hWnd, cls, cls.Capacity);
        result.Add(new [] { hWnd.ToInt64().ToString(), title.ToString(), cls.ToString() });
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
"@

$started = Get-Date
$started.ToUniversalTime().ToString('o') | Set-Content -Encoding UTF8 -LiteralPath $readyPath
$deadline = $started.AddSeconds($TimeoutSeconds)
while (-not (Test-Path -LiteralPath $ownershipPath) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
if (-not (Test-Path -LiteralPath $ownershipPath)) { throw 'PowerPoint ownership record was not created before the watcher deadline.' }
$ownershipObservedAt = Get-Date
$ownership = Get-Content -Raw -LiteralPath $ownershipPath | ConvertFrom-Json
$ownedPid = [int]$ownership.processId
$ownedStart = [string]$ownership.processStartTime
if ($ownedPid -lt 1 -or [string]$ownership.processName -ne 'POWERPNT' -or -not $ownedStart) { throw 'PowerPoint ownership record is invalid.' }
$visible = @()
$identityDrift = $false
$ownedProcessExited = $false
$timedOut = $false
$sampleCount = 0
$ownedProcess = Get-Process -Id $ownedPid -ErrorAction SilentlyContinue
if (-not $ownedProcess -or [string]$ownedProcess.ProcessName -ne 'POWERPNT' -or $ownedProcess.StartTime.ToUniversalTime().ToString('o') -ne $ownedStart) {
  throw 'The exact owned PowerPoint identity disappeared before the watcher armed.'
}
foreach ($window in [SlidewrightWindowProbe]::VisibleWindows([uint32]$ownedPid)) {
  $visible += [ordered]@{ handle = $window[0]; title = $window[1]; className = $window[2]; observedAt = (Get-Date).ToUniversalTime().ToString('o') }
}
$sampleCount++
$armedAt = (Get-Date).ToUniversalTime().ToString('o')
$armedAt | Set-Content -Encoding UTF8 -LiteralPath $armedPath
while ($true) {
  $sampleCount++
  $process = Get-Process -Id $ownedPid -ErrorAction SilentlyContinue
  if (-not $process) { $ownedProcessExited = $true; break }
  if ([string]$process.ProcessName -ne 'POWERPNT' -or $process.StartTime.ToUniversalTime().ToString('o') -ne $ownedStart) {
    # Process identities are immutable. A different identity at the same PID
    # proves the owned process exited and the operating system reused its PID.
    $ownedProcessExited = $true
    break
  }
  foreach ($window in [SlidewrightWindowProbe]::VisibleWindows([uint32]$ownedPid)) {
    $visible += [ordered]@{ handle = $window[0]; title = $window[1]; className = $window[2]; observedAt = (Get-Date).ToUniversalTime().ToString('o') }
  }
  if (Test-Path -LiteralPath $stopPath) { break }
  if ((Get-Date) -ge $deadline) { $timedOut = $true; break }
  Start-Sleep -Milliseconds 100
}
$signals = @()
$eventLogQuerySucceeded = $false
$eventLogError = $null
$finalProcess = Get-Process -Id $ownedPid -ErrorAction SilentlyContinue
if (-not $finalProcess -or [string]$finalProcess.ProcessName -ne 'POWERPNT' -or $finalProcess.StartTime.ToUniversalTime().ToString('o') -ne $ownedStart) {
  $ownedProcessExited = $true
}
try {
  foreach ($event in @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $started } -ErrorAction Stop)) {
    $message = [string]$event.Message
    if ($message -notmatch '(?i)repair|removed content|unreadable|damaged|corrupt') { continue }
    $signals += [ordered]@{ provider = [string]$event.ProviderName; id = [int]$event.Id; timeCreated = $event.TimeCreated.ToUniversalTime().ToString('o'); message = $message }
  }
  $eventLogQuerySucceeded = $true
} catch {
  if ([string]$_.FullyQualifiedErrorId -like 'NoMatchingEventsFound,*') {
    # A successfully queried time window with zero Application events is a
    # successful repair-signal check, not a telemetry failure.
    $eventLogQuerySucceeded = $true
  } else {
    $eventLogError = $_.Exception.Message
  }
}
$finished = Get-Date
$result = [ordered]@{
  schemaVersion = 'slidewright-powerpoint-window-watch/v1'
  valid = -not $identityDrift -and -not $timedOut -and $ownedProcessExited -and $eventLogQuerySucceeded -and $visible.Count -eq 0 -and $signals.Count -eq 0
  startedAt = $started.ToUniversalTime().ToString('o')
  ownershipObservedAt = $ownershipObservedAt.ToUniversalTime().ToString('o')
  armedAt = $armedAt
  finishedAt = $finished.ToUniversalTime().ToString('o')
  processId = $ownedPid
  processStartTime = $ownedStart
  sampleCount = $sampleCount
  identityDrift = $identityDrift
  ownedProcessExited = $ownedProcessExited
  timedOut = $timedOut
  eventLogQuerySucceeded = $eventLogQuerySucceeded
  eventLogError = $eventLogError
  unexpectedVisibleWindows = $visible
  repairSignals = $signals
}
$result | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
if (-not $result.valid) { exit 2 }
