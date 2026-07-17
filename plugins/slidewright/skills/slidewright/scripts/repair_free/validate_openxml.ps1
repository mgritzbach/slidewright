param(
  [Parameter(Mandatory = $true)][string]$InputPptx,
  [Parameter(Mandatory = $true)][string]$AssemblyPath,
  [Parameter(Mandatory = $true)][string]$ReportJson
)

$ErrorActionPreference = 'Stop'
$inputPath = [IO.Path]::GetFullPath($InputPptx)
$assembly = [IO.Path]::GetFullPath($AssemblyPath)
$reportPath = [IO.Path]::GetFullPath($ReportJson)
if (-not (Test-Path -LiteralPath $inputPath -PathType Leaf)) { throw "PowerPoint package does not exist: $inputPath" }
if (-not (Test-Path -LiteralPath $assembly -PathType Leaf)) { throw "Open XML SDK assembly does not exist: $assembly" }
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($reportPath)) | Out-Null

Add-Type -Path $assembly
$document = $null
$errors = @()
try {
  $document = [DocumentFormat.OpenXml.Packaging.PresentationDocument]::Open($inputPath, $false)
  $validator = New-Object DocumentFormat.OpenXml.Validation.OpenXmlValidator([DocumentFormat.OpenXml.FileFormatVersions]::Office2019)
  foreach ($item in @($validator.Validate($document))) {
    $errors += [ordered]@{
      id = [string]$item.Id
      description = [string]$item.Description
      errorType = [string]$item.ErrorType
      partUri = if ($item.Part) { [string]$item.Part.Uri } else { $null }
      path = if ($item.Path) { [string]$item.Path.XPath } else { $null }
      relatedNode = if ($item.RelatedNode) { [string]$item.RelatedNode.LocalName } else { $null }
    }
  }
} finally {
  if ($document) { $document.Dispose() }
}
$result = [ordered]@{
  schemaVersion = 'slidewright-openxml-validation/v1'
  valid = $errors.Count -eq 0
  application = 'DocumentFormat.OpenXml'
  validatorVersion = [string][DocumentFormat.OpenXml.Packaging.PresentationDocument].Assembly.GetName().Version
  fileFormat = 'Office2019'
  input = $inputPath
  inputSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $inputPath).Hash.ToLowerInvariant()
  errorCount = $errors.Count
  errors = $errors
}
$result | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -LiteralPath $reportPath
$result | ConvertTo-Json -Depth 10
if (-not $result.valid) { exit 2 }
