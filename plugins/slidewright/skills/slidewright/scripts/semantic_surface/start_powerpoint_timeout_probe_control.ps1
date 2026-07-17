param(
  [Parameter(Mandatory = $true)][string]$ProbeScript,
  [Parameter(Mandatory = $true)][string]$OwnershipRecordJson,
  [Parameter(Mandatory = $true)][string]$WorkerIntentJson,
  [Parameter(Mandatory = $true)][string]$ReadyMarker,
  [Parameter(Mandatory = $true)][string]$IdentityReceiptJson,
  [int]$HoldSeconds = 120
)

$ErrorActionPreference = 'Stop'

function ConvertTo-QuotedArgument([string]$Value) {
  if ($Value.Contains('"')) { throw 'Timeout-probe control arguments cannot contain quote characters.' }
  return '"' + $Value + '"'
}

foreach ($path in @($ProbeScript, $OwnershipRecordJson, $WorkerIntentJson, $ReadyMarker, $IdentityReceiptJson)) {
  $directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($path))
  if ($directory) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
}

$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$argumentLine = @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', (ConvertTo-QuotedArgument ([IO.Path]::GetFullPath($ProbeScript))),
  '-OwnershipRecordJson', (ConvertTo-QuotedArgument ([IO.Path]::GetFullPath($OwnershipRecordJson))),
  '-WorkerIntentJson', (ConvertTo-QuotedArgument ([IO.Path]::GetFullPath($WorkerIntentJson))),
  '-ReadyMarker', (ConvertTo-QuotedArgument ([IO.Path]::GetFullPath($ReadyMarker))),
  '-HoldSeconds', [string]$HoldSeconds
) -join ' '

$worker = $null
$identityWritten = $false
try {
  $worker = Start-Process -FilePath $powerShell -ArgumentList $argumentLine -WindowStyle Hidden -PassThru
  $live = Get-Process -Id $worker.Id -ErrorAction Stop
  $identity = [ordered]@{
    schemaVersion = 'slidewright-forced-parent-worker-identity/v1'
    processId = [int]$live.Id
    processName = [string]$live.ProcessName
    processStartTime = $live.StartTime.ToUniversalTime().ToString('o')
  }
  $receiptPath = [IO.Path]::GetFullPath($IdentityReceiptJson)
  $temporary = "$receiptPath.tmp-$PID"
  $identity | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 -LiteralPath $temporary
  Move-Item -Force -LiteralPath $temporary -Destination $receiptPath
  $identityWritten = $true
  $identity | ConvertTo-Json -Compress
} catch {
  if ($worker -and -not $identityWritten) {
    try {
      $candidate = Get-Process -Id $worker.Id -ErrorAction SilentlyContinue
      if ($candidate -and $candidate.StartTime -eq $worker.StartTime) {
        $candidate.Kill()
        [void]$candidate.WaitForExit(10000)
      }
    } catch { }
  }
  throw
}
