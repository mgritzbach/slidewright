param(
  [Parameter(Mandatory = $true)][string]$WatchdogScript,
  [Parameter(Mandatory = $true)][int]$ParentProcessId,
  [Parameter(Mandatory = $true)][string]$ParentProcessStartTime,
  [Parameter(Mandatory = $true)][string]$StagingDir,
  [Parameter(Mandatory = $true)][string]$CompletionMarker,
  [Parameter(Mandatory = $true)][string]$ReadyMarker,
  [Parameter(Mandatory = $true)][string]$RecoveryReportJson,
  [Parameter(Mandatory = $true)][string]$CleanupScript,
  [Parameter(Mandatory = $true)][string]$DiagnosticLog,
  [int]$ScanWindowMilliseconds = 15000
)

$ErrorActionPreference = 'Stop'
$diagnosticPath = [IO.Path]::GetFullPath($DiagnosticLog)
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($diagnosticPath)) | Out-Null

try {
  & ([IO.Path]::GetFullPath($WatchdogScript)) `
    -ParentProcessId $ParentProcessId `
    -ParentProcessStartTime $ParentProcessStartTime `
    -StagingDir $StagingDir `
    -CompletionMarker $CompletionMarker `
    -ReadyMarker $ReadyMarker `
    -RecoveryReportJson $RecoveryReportJson `
    -CleanupScript $CleanupScript `
    -ScanWindowMilliseconds $ScanWindowMilliseconds *>> $diagnosticPath
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
  exit 0
} catch {
  ($_ | Out-String) | Add-Content -Encoding UTF8 -LiteralPath $diagnosticPath
  exit 1
}
