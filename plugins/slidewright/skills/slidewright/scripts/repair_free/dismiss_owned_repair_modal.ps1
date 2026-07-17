param(
  [Parameter(Mandatory = $true)][string]$OwnershipRecordJson,
  [Parameter(Mandatory = $true)][string]$WatcherReportJson,
  [Parameter(Mandatory = $true)][string]$StopMarker
)

$ErrorActionPreference = 'Stop'
$ownershipPath = [IO.Path]::GetFullPath($OwnershipRecordJson)
$watcherPath = [IO.Path]::GetFullPath($WatcherReportJson)
$stopPath = [IO.Path]::GetFullPath($StopMarker)
$result = [ordered]@{
  schemaVersion = 'slidewright-repair-modal-dismissal/v1'
  valid = $false
  dismissed = $false
  safeRefusal = $false
  reason = $null
  processId = $null
  processStartTime = $null
  workerProcessId = $null
  workerProcessStartTime = $null
  ownershipSha256 = $null
  exactModalEvidence = $false
  persistentSampleCount = 0
  persistenceMilliseconds = 0
  liveModalHandles = @()
  closedModalHandles = @()
  verifiedClosedModalHandles = @()
}

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SlidewrightRepairModalDismissal {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
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

try {
  if (-not (Test-Path -LiteralPath $ownershipPath) -or -not (Test-Path -LiteralPath $watcherPath) -or -not (Test-Path -LiteralPath $stopPath)) {
    throw 'Repair-modal dismissal requires ownership, watcher, and timeout-marker evidence.'
  }
  if ((Get-Content -Raw -LiteralPath $stopPath).Trim() -ne 'repair-control-timeout') { throw 'Repair-modal dismissal requires the exact repair-control timeout marker.' }
  $ownership = Get-Content -Raw -LiteralPath $ownershipPath | ConvertFrom-Json
  $watcher = Get-Content -Raw -LiteralPath $watcherPath | ConvertFrom-Json
  $ownershipSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $ownershipPath).Hash.ToLowerInvariant()
  $ownedPid = [int]$ownership.processId
  $ownedStart = [string]$ownership.processStartTime
  $workerPid = [int]$ownership.workerProcessId
  $workerStart = [string]$ownership.workerProcessStartTime
  $result.processId = $ownedPid
  $result.processStartTime = $ownedStart
  $result.workerProcessId = $workerPid
  $result.workerProcessStartTime = $workerStart
  $result.ownershipSha256 = $ownershipSha256
  if ($ownedPid -lt 1 -or [string]$ownership.processName -ne 'POWERPNT' -or -not $ownedStart -or [bool]$ownership.expectedApplicationVisible) {
    throw 'Repair-modal dismissal received an invalid PowerPoint ownership record.'
  }
  if ($workerPid -lt 1 -or [string]$ownership.workerProcessName -ne 'powershell' -or -not $workerStart) {
    throw 'Repair-modal dismissal requires the exact live PowerPoint worker identity.'
  }
  $worker = Get-Process -Id $workerPid -ErrorAction SilentlyContinue
  if (-not $worker -or [string]$worker.ProcessName -ne 'powershell' -or $worker.StartTime.ToUniversalTime().ToString('o') -ne $workerStart) {
    throw 'The exact PowerPoint worker is not live at modal dismissal.'
  }
  if ([string]$watcher.schemaVersion -ne 'slidewright-powerpoint-window-watch/v1' -or [bool]$watcher.valid -or [bool]$watcher.identityDrift -or [bool]$watcher.ownedProcessExited -or [bool]$watcher.timedOut) {
    throw 'Watcher evidence does not represent a bounded invalid live-process observation.'
  }
  if ([int]$watcher.processId -ne $ownedPid -or [string]$watcher.processStartTime -ne $ownedStart -or [int]$watcher.sampleCount -lt 20) {
    throw 'Watcher evidence does not bind enough samples to the exact owned PowerPoint identity.'
  }
  if ([string]$watcher.ownershipSha256 -ne $ownershipSha256 -or [int]$watcher.workerProcessId -ne $workerPid -or [string]$watcher.workerProcessName -ne 'powershell' -or [string]$watcher.workerProcessStartTime -ne $workerStart) {
    throw 'Watcher evidence is not bound to the exact ownership record and worker identity.'
  }
  $watcherStarted = [DateTimeOffset]::Parse([string]$watcher.startedAt)
  $watcherArmed = [DateTimeOffset]::Parse([string]$watcher.armedAt)
  $watcherFinished = [DateTimeOffset]::Parse([string]$watcher.finishedAt)
  if ($watcherArmed -lt $watcherStarted -or $watcherFinished -lt $watcherArmed -or ([DateTimeOffset]::UtcNow - $watcherFinished).TotalSeconds -gt 30) {
    throw 'Watcher timestamps are stale or out of order.'
  }
  $allObserved = @($watcher.unexpectedVisibleWindows)
  if ($allObserved.Count -lt 10 -or @($allObserved | Where-Object { [string]$_.className -ne 'NUIDialog' }).Count -gt 0) {
    throw 'Watcher observed a non-modal same-process window or too few repair-modal samples.'
  }
  $persistent = @()
  foreach ($group in @($allObserved | Group-Object handle)) {
    $samples = @($group.Group | Sort-Object { [DateTimeOffset]::Parse([string]$_.observedAt) })
    $first = [DateTimeOffset]::Parse([string]$samples[0].observedAt)
    $last = [DateTimeOffset]::Parse([string]$samples[-1].observedAt)
    $duration = ($last - $first).TotalMilliseconds
    if ($samples.Count -ge 10 -and $duration -ge 5000 -and ($watcherFinished - $last).TotalMilliseconds -le 1000) {
      $persistent += [ordered]@{ handle = [string]$group.Name; sampleCount = $samples.Count; firstObservedAt = $first.ToString('o'); lastObservedAt = $last.ToString('o'); persistenceMilliseconds = [int][Math]::Floor($duration) }
    }
  }
  if ($persistent.Count -lt 1) { throw 'No single repair-modal handle persisted through the timeout boundary.' }
  $persistentSampleCount = 0
  $persistenceMilliseconds = 0
  foreach ($item in $persistent) {
    $persistentSampleCount += [int]$item['sampleCount']
    $persistenceMilliseconds = [Math]::Max($persistenceMilliseconds, [int]$item['persistenceMilliseconds'])
  }
  $result.persistentSampleCount = $persistentSampleCount
  $result.persistenceMilliseconds = $persistenceMilliseconds
  $processes = @((Get-Process POWERPNT -ErrorAction SilentlyContinue) | ForEach-Object { $_ })
  if ($processes.Count -ne 1 -or [int]$processes[0].Id -ne $ownedPid) { throw 'Global PowerPoint isolation was lost before modal dismissal.' }
  $process = $processes[0]
  if ([string]$process.ProcessName -ne 'POWERPNT' -or $process.StartTime.ToUniversalTime().ToString('o') -ne $ownedStart) {
    throw 'Live PowerPoint identity does not match the ownership receipt.'
  }
  $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ownedPid" -ErrorAction Stop
  if ([string]$processInfo.CommandLine -notmatch '(?i)(?:^|\s)/AUTOMATION(?:\s|$)') { throw 'Owned modal process is not an Office automation process.' }
  $executablePath = [IO.Path]::GetFullPath([string]$processInfo.ExecutablePath)
  if ([string]$ownership.executableSha256) {
    $actualExecutableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $executablePath).Hash.ToLowerInvariant()
    if ($actualExecutableSha256 -ne [string]$ownership.executableSha256) { throw 'Owned modal executable hash drifted.' }
  }
  $persistentHandles = @($persistent | ForEach-Object { [string]$_.handle })
  $liveWindows = @([SlidewrightRepairModalDismissal]::VisibleWindows([uint32]$ownedPid))
  if ($liveWindows.Count -lt 1) { throw 'The recorded repair modal is no longer live.' }
  foreach ($window in $liveWindows) {
    $handle = [string]$window[0]
    $className = [string]$window[2]
    if ($className -ne 'NUIDialog' -or -not ($persistentHandles -contains $handle)) {
      throw "A live same-process user or unrecorded window blocks modal dismissal: $handle $className"
    }
    $result.liveModalHandles += [ordered]@{ handle = $handle; title = [string]$window[1]; className = $className }
  }
  $result.exactModalEvidence = $true
  foreach ($window in $result.liveModalHandles) {
    if ([SlidewrightRepairModalDismissal]::PostMessage([IntPtr]([int64]$window.handle), 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) {
      $result.closedModalHandles += [string]$window.handle
    }
  }
  if ($result.closedModalHandles.Count -ne $result.liveModalHandles.Count) { throw 'Not every exact live repair-modal handle accepted WM_CLOSE.' }
  Start-Sleep -Milliseconds 750
  $remainingWindows = @([SlidewrightRepairModalDismissal]::VisibleWindows([uint32]$ownedPid))
  foreach ($window in $result.liveModalHandles) {
    if (@($remainingWindows | Where-Object { [string]$_[0] -eq [string]$window.handle }).Count -gt 0) {
      throw "The exact repair-modal handle remained visible after WM_CLOSE: $($window.handle)"
    }
    $result.verifiedClosedModalHandles += [string]$window.handle
  }
  $result.valid = $true
  $result.dismissed = $true
  $result.reason = 'exact-persistent-repair-modal-dismissed'
} catch {
  $result.safeRefusal = $true
  $result.reason = "line $($_.InvocationInfo.ScriptLineNumber): $($_.Exception.Message)"
}

$result | ConvertTo-Json -Depth 8 -Compress
if (-not $result.valid) { exit 1 }
