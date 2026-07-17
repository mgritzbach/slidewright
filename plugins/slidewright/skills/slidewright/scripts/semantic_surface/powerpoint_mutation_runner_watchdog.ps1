param(
  [Parameter(Mandatory = $true)][int]$ParentProcessId,
  [Parameter(Mandatory = $true)][string]$ParentProcessStartTime,
  [Parameter(Mandatory = $true)][string]$StagingDir,
  [Parameter(Mandatory = $true)][string]$CompletionMarker,
  [Parameter(Mandatory = $true)][string]$ReadyMarker,
  [Parameter(Mandatory = $true)][string]$RecoveryReportJson,
  [Parameter(Mandatory = $true)][string]$CleanupScript,
  [int]$ScanWindowMilliseconds = 15000,
  [int]$ScanIntervalMilliseconds = 250
)

$ErrorActionPreference = 'Stop'
$stagingPath = [IO.Path]::GetFullPath($StagingDir)
$completionPath = [IO.Path]::GetFullPath($CompletionMarker)
$readyPath = [IO.Path]::GetFullPath($ReadyMarker)
$reportPath = [IO.Path]::GetFullPath($RecoveryReportJson)
$cleanupPath = [IO.Path]::GetFullPath($CleanupScript)

function Write-JsonAtomically([string]$Path, $Value) {
  New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($Path)) | Out-Null
  $temporary = "$Path.tmp"
  $Value | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -LiteralPath $temporary
  Move-Item -Force -LiteralPath $temporary -Destination $Path
}

function Read-JsonSafely([string]$Path) {
  try { return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json } catch { return $null }
}

function Test-ContainedPath([string]$Candidate, [string]$Root) {
  if (-not $Candidate) { return $false }
  try {
    $candidatePath = [IO.Path]::GetFullPath($Candidate)
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    return $candidatePath.Equals($rootPath, [StringComparison]::OrdinalIgnoreCase) -or
      $candidatePath.StartsWith("$rootPath$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}

function Get-ProcessIdentity($Process) {
  if (-not $Process) { return $null }
  return [ordered]@{
    processId = [int]$Process.Id
    processName = [string]$Process.ProcessName
    processStartTime = $Process.StartTime.ToUniversalTime().ToString('o')
  }
}

function Test-ExactIdentity($Process, $Record) {
  if (-not $Process -or -not $Record) { return $false }
  $actual = Get-ProcessIdentity $Process
  return $actual.processId -eq [int]$Record.workerProcessId -and
    $actual.processName.Equals([string]$Record.workerProcessName, [StringComparison]::OrdinalIgnoreCase) -and
    $actual.processStartTime -eq [string]$Record.workerProcessStartTime
}

function Invoke-OwnershipCleanup([string]$OwnershipPath) {
  try {
    $cleanupOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $cleanupPath -OwnershipRecordJson $OwnershipPath 2>$null
    return ([string]$cleanupOutput | ConvertFrom-Json)
  } catch {
    return [ordered]@{ valid = $false; cleaned = $false; reason = $_.Exception.Message }
  }
}

New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($readyPath)) | Out-Null
$parent = Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
$parentIdentityMatched = $false
if ($parent -and $parent.StartTime.ToUniversalTime().ToString('o') -eq $ParentProcessStartTime) {
  $parentIdentityMatched = $true
}

$initialPowerPoint = @((Get-Process POWERPNT -ErrorAction SilentlyContinue) | ForEach-Object { Get-ProcessIdentity $_ })
Set-Content -Encoding UTF8 -LiteralPath $readyPath -Value 'ready'

if (-not $parentIdentityMatched) {
  Write-JsonAtomically $reportPath ([ordered]@{
    schemaVersion = 'slidewright-runner-watchdog/v1'
    valid = $false
    safe = $false
    recovered = $false
    parentProcessId = $ParentProcessId
    parentIdentityMatched = $false
    parentExitedWithoutCompletionMarker = $false
    intentsFound = 0
    recordsFound = 0
    recoveries = @()
    problems = @('parent-process-identity-mismatch')
  })
  Remove-Item -Force -LiteralPath $readyPath -ErrorAction SilentlyContinue
  exit 1
}

while (-not $parent.HasExited) {
  if (Test-Path -LiteralPath $completionPath) {
    Remove-Item -Force -LiteralPath $readyPath -ErrorAction SilentlyContinue
    exit 0
  }
  Start-Sleep -Milliseconds ([Math]::Max(50, $ScanIntervalMilliseconds))
  $parent.Refresh()
}

if (Test-Path -LiteralPath $completionPath) {
  Remove-Item -Force -LiteralPath $readyPath -ErrorAction SilentlyContinue
  exit 0
}

$recoveries = @()
$problems = @()
$knownIntents = @{}
$knownOwnerships = @{}
$processedWorkerIdentities = @{}
$cleanedOwnerships = @{}
$scanDeadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max(1000, $ScanWindowMilliseconds))

do {
  $intentFiles = if (Test-Path -LiteralPath $stagingPath) {
    @(Get-ChildItem -LiteralPath $stagingPath -Recurse -File -Filter '*worker-intent.json' -ErrorAction SilentlyContinue)
  } else { @() }
  $ownershipFiles = if (Test-Path -LiteralPath $stagingPath) {
    @(Get-ChildItem -LiteralPath $stagingPath -Recurse -File -Filter '*ownership.json' -ErrorAction SilentlyContinue)
  } else { @() }

  foreach ($intentFile in $intentFiles) {
    $knownIntents[$intentFile.FullName] = $true
    $record = Read-JsonSafely $intentFile.FullName
    if (-not $record -or [string]$record.schemaVersion -ne 'slidewright-worker-intent/v1') {
      if (-not ($problems -contains "invalid-intent:$($intentFile.Name)")) { $problems += "invalid-intent:$($intentFile.Name)" }
      continue
    }
    $workerName = [string]$record.workerProcessName
    $ownershipRecordPath = [string]$record.ownershipRecordPath
    if ([int]$record.workerProcessId -lt 1 -or -not $workerName -or -not [string]$record.workerProcessStartTime -or
        @('powershell', 'pwsh') -notcontains $workerName.ToLowerInvariant() -or
        -not (Test-ContainedPath $ownershipRecordPath $stagingPath)) {
      if (-not ($problems -contains "unsafe-intent:$($intentFile.Name)")) { $problems += "unsafe-intent:$($intentFile.Name)" }
      continue
    }
    $workerKey = "$([int]$record.workerProcessId)|$($workerName.ToLowerInvariant())|$([string]$record.workerProcessStartTime)"
    if (-not $processedWorkerIdentities.ContainsKey($workerKey)) {
      $processedWorkerIdentities[$workerKey] = $record
      $worker = Get-Process -Id ([int]$record.workerProcessId) -ErrorAction SilentlyContinue
      $matched = Test-ExactIdentity $worker $record
      $terminated = $false
      if ($worker -and -not $matched) { $problems += "worker-identity-mismatch:$workerKey" }
      if ($matched) {
        $worker.Kill()
        $terminated = $worker.WaitForExit(15000)
        if (-not $terminated) { $problems += "worker-did-not-exit:$workerKey" }
      }
      $recoveries += [ordered]@{
        source = 'worker-intent'
        record = $intentFile.Name
        workerProcessId = [int]$record.workerProcessId
        workerProcessName = $workerName
        workerMatched = $matched
        workerTerminated = $terminated
        workerAlreadyExited = -not [bool]$worker
        ownershipRecord = [IO.Path]::GetFileName($ownershipRecordPath)
        cleanup = $null
      }
    }
  }

  foreach ($ownershipFile in $ownershipFiles) {
    $knownOwnerships[$ownershipFile.FullName] = $true
    if ($cleanedOwnerships.ContainsKey($ownershipFile.FullName)) { continue }
    $record = Read-JsonSafely $ownershipFile.FullName
    if (-not $record -or [string]$record.schemaVersion -ne 'slidewright-owned-powerpoint/v1') {
      $problems += "invalid-ownership:$($ownershipFile.Name)"
      $cleanedOwnerships[$ownershipFile.FullName] = $false
      continue
    }
    $workerName = [string]$record.workerProcessName
    if ([int]$record.workerProcessId -lt 1 -or -not $workerName -or -not [string]$record.workerProcessStartTime -or
        @('powershell', 'pwsh') -notcontains $workerName.ToLowerInvariant()) {
      $problems += "unsafe-ownership:$($ownershipFile.Name)"
      $cleanedOwnerships[$ownershipFile.FullName] = $false
      continue
    }
    $workerKey = "$([int]$record.workerProcessId)|$($workerName.ToLowerInvariant())|$([string]$record.workerProcessStartTime)"
    if (-not $processedWorkerIdentities.ContainsKey($workerKey)) {
      $processedWorkerIdentities[$workerKey] = $record
      $worker = Get-Process -Id ([int]$record.workerProcessId) -ErrorAction SilentlyContinue
      $matched = Test-ExactIdentity $worker $record
      $terminated = $false
      if ($worker -and -not $matched) { $problems += "worker-identity-mismatch:$workerKey" }
      if ($matched) {
        $worker.Kill()
        $terminated = $worker.WaitForExit(15000)
        if (-not $terminated) { $problems += "worker-did-not-exit:$workerKey" }
      }
      $recoveries += [ordered]@{
        source = 'ownership-record'
        record = $ownershipFile.Name
        workerProcessId = [int]$record.workerProcessId
        workerProcessName = $workerName
        workerMatched = $matched
        workerTerminated = $terminated
        workerAlreadyExited = -not [bool]$worker
        ownershipRecord = $ownershipFile.Name
        cleanup = $null
      }
    }
    $cleanup = Invoke-OwnershipCleanup $ownershipFile.FullName
    $cleanedOwnerships[$ownershipFile.FullName] = $cleanup
    if (-not $cleanup.valid) { $problems += "cleanup-failed:$($ownershipFile.Name):$($cleanup.reason)" }
    for ($index = $recoveries.Count - 1; $index -ge 0; $index--) {
      if ($recoveries[$index].ownershipRecord -eq $ownershipFile.Name -and -not $recoveries[$index].cleanup) {
        $recoveries[$index].cleanup = $cleanup
        break
      }
    }
  }
  if ([DateTime]::UtcNow -lt $scanDeadline) { Start-Sleep -Milliseconds ([Math]::Max(50, $ScanIntervalMilliseconds)) }
} while ([DateTime]::UtcNow -lt $scanDeadline)

$liveWorkerIdentities = @()
foreach ($record in $processedWorkerIdentities.Values) {
  $worker = Get-Process -Id ([int]$record.workerProcessId) -ErrorAction SilentlyContinue
  if (Test-ExactIdentity $worker $record) { $liveWorkerIdentities += Get-ProcessIdentity $worker }
}

$newPowerPointProcesses = @()
foreach ($powerPoint in @(Get-Process POWERPNT -ErrorAction SilentlyContinue)) {
  $identity = Get-ProcessIdentity $powerPoint
  $wasPresent = @($initialPowerPoint | Where-Object {
    $_.processId -eq $identity.processId -and $_.processStartTime -eq $identity.processStartTime
  }).Count -gt 0
  if (-not $wasPresent) { $newPowerPointProcesses += $identity }
}

if ($liveWorkerIdentities.Count -gt 0) { $problems += 'exact-worker-still-alive-after-recovery' }
if ($newPowerPointProcesses.Count -gt 0) { $problems += 'new-powerpoint-process-remains-after-recovery' }
$safe = $problems.Count -eq 0
$recovered = @($recoveries | Where-Object { $_.workerTerminated -or ($_.cleanup -and $_.cleanup.cleaned) }).Count -gt 0

$report = [ordered]@{
  schemaVersion = 'slidewright-runner-watchdog/v1'
  valid = $safe
  safe = $safe
  recovered = $recovered
  parentProcessId = $ParentProcessId
  parentIdentityMatched = $parentIdentityMatched
  parentExitedWithoutCompletionMarker = $true
  scanWindowMilliseconds = $ScanWindowMilliseconds
  intentsFound = $knownIntents.Count
  recordsFound = $knownOwnerships.Count
  recoveries = $recoveries
  liveWorkerIdentities = $liveWorkerIdentities
  newPowerPointProcesses = $newPowerPointProcesses
  problems = $problems
}
Write-JsonAtomically $reportPath $report
Remove-Item -Force -LiteralPath $readyPath -ErrorAction SilentlyContinue
if (-not $safe) { exit 1 }

