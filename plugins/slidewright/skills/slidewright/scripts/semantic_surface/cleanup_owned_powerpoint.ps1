param(
  [Parameter(Mandatory = $true)][string]$OwnershipRecordJson
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'presentation_path_identity.ps1')
$recordPath = [IO.Path]::GetFullPath($OwnershipRecordJson)
$result = [ordered]@{
  valid = $false
  cleaned = $false
  safeRefusal = $false
  reason = $null
  attachedProcessId = $null
  headlessAutomationFallback = $false
  wmQuitThreadsSignaled = 0
  applicationVisible = $null
  openPresentations = @()
  foreignPresentations = @()
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SlidewrightCleanupNativeMethods {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PostThreadMessage(uint threadId, uint message, IntPtr wParam, IntPtr lParam);
}
"@

function Get-PresentationInventory($Application) {
  $inventory = @()
  $count = [int]$Application.Presentations.Count
  for ($index = 1; $index -le $count; $index++) {
    $presentation = $Application.Presentations.Item($index)
    $fullName = $null
    $name = $null
    try { $fullName = [string]$presentation.FullName } catch { $fullName = $null }
    try { $name = [string]$presentation.Name } catch { $name = $null }
    $inventory += [ordered]@{ name = $name; fullName = $fullName }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation)
  }
  return @($inventory)
}

$application = $null
try {
  if (-not (Test-Path -LiteralPath $recordPath)) { throw 'Ownership record does not exist.' }
  $record = Get-Content -Raw -LiteralPath $recordPath | ConvertFrom-Json
  if ([string]$record.processName -ne 'POWERPNT') { throw 'Ownership record processName must be POWERPNT.' }
  $ownedPid = [int]$record.processId
  if ($ownedPid -lt 1) { throw 'Ownership record processId must be positive.' }
  $ownedStart = [string]$record.processStartTime
  if (-not $ownedStart) { throw 'Ownership record processStartTime is required.' }
  $ownedPresentationPaths = @($record.ownedPresentationPaths | ForEach-Object { Get-NormalizedPresentationPath ([string]$_) } | Where-Object { $_ })
  $process = Get-Process -Id $ownedPid -ErrorAction SilentlyContinue
  if (-not $process) {
    $result.valid = $true
    $result.cleaned = $true
    $result.reason = 'owned-process-already-exited'
  } else {
    $actualName = [string]$process.ProcessName
    $actualStart = $process.StartTime.ToUniversalTime().ToString('o')
    if ($actualName -ne 'POWERPNT' -or $actualStart -ne $ownedStart) {
      $result.reason = 'live-process-does-not-match-ownership-record'
    } else {
      try {
        $application = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
      } catch {
        $result.valid = $true
        $result.safeRefusal = $true
        $result.reason = 'owned-process-could-not-be-inspected-through-the-running-object-table'
      }
      if ($application) {
        [uint32]$attachedProcessId = 0
        [void][SlidewrightCleanupNativeMethods]::GetWindowThreadProcessId([IntPtr]([long]$application.HWND), [ref]$attachedProcessId)
        $result.attachedProcessId = [int]$attachedProcessId
        $applicationMatchesOwnedProcess = [int]$attachedProcessId -eq $ownedPid
        if (-not $applicationMatchesOwnedProcess -and [int]$attachedProcessId -eq 0 -and $ownedPresentationPaths.Count -eq 0 -and -not [bool]$record.expectedApplicationVisible) {
          try {
            $powerPointProcesses = @((Get-Process POWERPNT -ErrorAction SilentlyContinue) | ForEach-Object { $_ })
            $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ownedPid" -ErrorAction Stop
            $applicationVersion = [string]$application.Version
            $applicationBuild = $null
            try { $applicationBuild = [string]$application.Build } catch { $applicationBuild = $null }
            $recordVersionMatches = -not [string]$record.version -or [string]$record.version -eq $applicationVersion
            $recordBuildMatches = -not [string]$record.build -or [string]$record.build -eq $applicationBuild
            if ($powerPointProcesses.Count -eq 1 -and [int]$powerPointProcesses[0].Id -eq $ownedPid -and
                [string]$processInfo.CommandLine -match '(?i)(?:^|\s)/AUTOMATION(?:\s|$)' -and
                $recordVersionMatches -and $recordBuildMatches) {
              $applicationMatchesOwnedProcess = $true
              $result.headlessAutomationFallback = $true
            }
          } catch { $applicationMatchesOwnedProcess = $false }
        }
        if (-not $applicationMatchesOwnedProcess) {
          $result.valid = $true
          $result.safeRefusal = $true
          $result.reason = 'running-object-table-application-does-not-match-owned-process'
        } else {
          $result.applicationVisible = ([int]$application.Visible -ne 0)
          if ($result.applicationVisible) {
            $result.valid = $true
            $result.safeRefusal = $true
            $result.reason = 'owned-process-application-is-visible'
          } else {
            $firstInventory = @(Get-PresentationInventory $application)
            Start-Sleep -Milliseconds 150
            $secondInventory = @(Get-PresentationInventory $application)
            $result.openPresentations = $secondInventory
            $foreign = @($firstInventory + $secondInventory | Where-Object {
              $normalized = Get-NormalizedPresentationPath ([string]$_.fullName) $ownedPresentationPaths
              -not $normalized -or -not ($ownedPresentationPaths -contains $normalized)
            })
            $result.foreignPresentations = $foreign
            if ($foreign.Count -gt 0) {
              $result.valid = $true
              $result.safeRefusal = $true
              $result.reason = 'owned-process-has-foreign-presentations'
            } else {
              $closeCandidates = @()
              $candidateViolation = $null
              $capturedCount = [int]$application.Presentations.Count
              for ($index = 1; $index -le $capturedCount; $index++) {
                if ([int]$application.Visible -ne 0) { $candidateViolation = 'owned-process-became-visible-before-candidate-capture'; break }
                $candidate = $application.Presentations.Item($index)
                $candidatePath = Get-NormalizedPresentationPath ([string]$candidate.FullName) $ownedPresentationPaths
                if (-not $candidatePath -or -not ($ownedPresentationPaths -contains $candidatePath)) {
                  $result.foreignPresentations += [ordered]@{ name = [string]$candidate.Name; fullName = [string]$candidate.FullName }
                  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($candidate)
                  $candidateViolation = 'owned-process-gained-a-foreign-presentation-before-candidate-capture'
                  break
                }
                $closeCandidates += $candidate
              }
              if (-not $candidateViolation -and [int]$application.Presentations.Count -ne $closeCandidates.Count) {
                $candidateViolation = 'owned-process-presentation-collection-changed-during-candidate-capture'
              }
              if (-not $candidateViolation) {
                foreach ($candidate in $closeCandidates) {
                  if ([int]$application.Visible -ne 0) { $candidateViolation = 'owned-process-became-visible-before-candidate-close'; break }
                  $candidatePath = Get-NormalizedPresentationPath ([string]$candidate.FullName) $ownedPresentationPaths
                  if (-not $candidatePath -or -not ($ownedPresentationPaths -contains $candidatePath)) {
                    $candidateViolation = 'owned-presentation-identity-changed-before-candidate-close'
                    break
                  }
                  $candidate.Saved = -1
                  $candidate.Close()
                }
              }
              foreach ($candidate in $closeCandidates) {
                try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($candidate) } catch { }
              }
              if ($candidateViolation) {
                $result.valid = $true
                $result.safeRefusal = $true
                $result.reason = $candidateViolation
              } else {
                Start-Sleep -Milliseconds 150
                if ([int]$application.Presentations.Count -ne 0 -or ([int]$application.Visible -ne 0)) {
                  $result.valid = $true
                  $result.safeRefusal = $true
                  $result.reason = 'owned-process-state-changed-before-com-release'
                } else {
                  $headlessQuitRequested = $false
                  if ($result.headlessAutomationFallback) {
                    $application.Quit()
                    $headlessQuitRequested = $true
                  }
                  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($application)
                  $application = $null
                  [GC]::Collect()
                  [GC]::WaitForPendingFinalizers()
                  $headlessQuitEscalatedToMessageLoop = $false
                  if ($headlessQuitRequested) {
                    $result.cleaned = $process.WaitForExit(5000)
                    if (-not $result.cleaned) {
                      $liveAfterQuit = Get-Process -Id $ownedPid -ErrorAction SilentlyContinue
                      if ($liveAfterQuit -and [string]$liveAfterQuit.ProcessName -eq 'POWERPNT' -and $liveAfterQuit.StartTime.ToUniversalTime().ToString('o') -eq $ownedStart) {
                        foreach ($thread in @($liveAfterQuit.Threads)) {
                          if ([SlidewrightCleanupNativeMethods]::PostThreadMessage([uint32]$thread.Id, 0x0012, [IntPtr]::Zero, [IntPtr]::Zero)) {
                            $result.wmQuitThreadsSignaled += 1
                          }
                        }
                        $headlessQuitEscalatedToMessageLoop = $result.wmQuitThreadsSignaled -gt 0
                        $result.cleaned = $liveAfterQuit.WaitForExit(45000)
                      }
                    }
                  } else {
                    $result.cleaned = $process.WaitForExit(45000)
                  }
                  $result.valid = $result.cleaned
                  $result.reason = if ($result.cleaned) {
                    if ($closeCandidates.Count -gt 0) { 'owned-process-exited-after-closing-owned-presentations' }
                    elseif ($headlessQuitEscalatedToMessageLoop) { 'owned-headless-automation-process-exited-after-wm-quit' }
                    elseif ($headlessQuitRequested) { 'owned-headless-automation-process-exited-after-quit' }
                    else { 'owned-process-exited-after-com-release' }
                  } else { 'owned-process-still-running-after-safe-com-release' }
                }
              }
            }
          }
        }
      }
    }
  }
} catch {
  $result.reason = $_.Exception.Message
} finally {
  if ($application) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($application) }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
$result | ConvertTo-Json -Compress
if (-not $result.valid) { exit 1 }
