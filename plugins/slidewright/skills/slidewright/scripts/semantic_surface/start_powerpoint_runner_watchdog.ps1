param(
  [Parameter(Mandatory = $true)][string]$EntrypointScript,
  [Parameter(Mandatory = $true)][string]$WatchdogScript,
  [Parameter(Mandatory = $true)][int]$ParentProcessId,
  [Parameter(Mandatory = $true)][string]$ParentProcessStartTime,
  [Parameter(Mandatory = $true)][string]$StagingDir,
  [Parameter(Mandatory = $true)][string]$CompletionMarker,
  [Parameter(Mandatory = $true)][string]$ReadyMarker,
  [Parameter(Mandatory = $true)][string]$RecoveryReportJson,
  [Parameter(Mandatory = $true)][string]$CleanupScript,
  [Parameter(Mandatory = $true)][string]$DiagnosticLog,
  [Parameter(Mandatory = $true)][string]$IdentityReceiptJson,
  [int]$ScanWindowMilliseconds = 15000
)

$ErrorActionPreference = 'Stop'

function ConvertTo-QuotedArgument([string]$Value) {
  if ($Value.Contains('"')) { throw 'Runner watchdog arguments cannot contain quote characters.' }
  return '"' + $Value + '"'
}

foreach ($path in @($EntrypointScript, $WatchdogScript, $StagingDir, $CompletionMarker, $ReadyMarker, $RecoveryReportJson, $CleanupScript, $DiagnosticLog, $IdentityReceiptJson)) {
  $directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($path))
  if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
}

$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$argumentLine = @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', (ConvertTo-QuotedArgument ([IO.Path]::GetFullPath($EntrypointScript))),
  '-WatchdogScript', (ConvertTo-QuotedArgument ([IO.Path]::GetFullPath($WatchdogScript))),
  '-ParentProcessId', [string]$ParentProcessId,
  '-ParentProcessStartTime', (ConvertTo-QuotedArgument $ParentProcessStartTime),
  '-StagingDir', (ConvertTo-QuotedArgument ([IO.Path]::GetFullPath($StagingDir))),
  '-CompletionMarker', (ConvertTo-QuotedArgument ([IO.Path]::GetFullPath($CompletionMarker))),
  '-ReadyMarker', (ConvertTo-QuotedArgument ([IO.Path]::GetFullPath($ReadyMarker))),
  '-RecoveryReportJson', (ConvertTo-QuotedArgument ([IO.Path]::GetFullPath($RecoveryReportJson))),
  '-CleanupScript', (ConvertTo-QuotedArgument ([IO.Path]::GetFullPath($CleanupScript))),
  '-DiagnosticLog', (ConvertTo-QuotedArgument ([IO.Path]::GetFullPath($DiagnosticLog))),
  '-ScanWindowMilliseconds', [string]$ScanWindowMilliseconds
) -join ' '

$watchdog = $null
$identityWritten = $false
try {
  $watchdog = Start-Process -FilePath $powerShell -ArgumentList $argumentLine -WindowStyle Hidden -PassThru
  $live = Get-Process -Id $watchdog.Id -ErrorAction Stop
  $identity = [ordered]@{
    schemaVersion = 'slidewright-runner-watchdog-identity/v1'
    processId = [int]$live.Id
    processName = [string]$live.ProcessName
    processStartTime = $live.StartTime.ToUniversalTime().ToString('o')
  }
  $receiptPath = [IO.Path]::GetFullPath($IdentityReceiptJson)
  $receiptTemporary = "$receiptPath.tmp-$PID"
  $identity | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 -LiteralPath $receiptTemporary
  Move-Item -Force -LiteralPath $receiptTemporary -Destination $receiptPath
  $identityWritten = $true
  $identity | ConvertTo-Json -Compress
} catch {
  if ($watchdog -and -not $identityWritten) {
    try {
      $candidate = Get-Process -Id $watchdog.Id -ErrorAction SilentlyContinue
      if ($candidate -and $candidate.StartTime -eq $watchdog.StartTime) {
        $candidate.Kill()
        [void]$candidate.WaitForExit(10000)
      }
    } catch { }
  }
  throw
}
