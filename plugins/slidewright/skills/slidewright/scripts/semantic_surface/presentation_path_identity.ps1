function Get-NormalizedPresentationPath([string]$Value, [string[]]$AllowedPresentationPaths = @()) {
  if (-not $Value) { return $null }
  try {
    if (-not $Value.StartsWith('https://', [StringComparison]::OrdinalIgnoreCase)) {
      return [IO.Path]::GetFullPath($Value)
    }
  } catch { return $null }

  try {
    $uri = [Uri]$Value
    if (-not $uri.Host.Equals('d.docs.live.net', [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $segments = @($uri.AbsolutePath.Trim('/') -split '/')
    if ($segments.Count -lt 2 -or -not $segments[0]) { return $null }
    $relativeSegments = @($segments | Select-Object -Skip 1 | ForEach-Object { [Uri]::UnescapeDataString($_) })
    if ($relativeSegments.Count -eq 0 -or @($relativeSegments | Where-Object {
      $_ -in @('', '.', '..') -or $_.Contains([IO.Path]::DirectorySeparatorChar) -or $_.Contains([IO.Path]::AltDirectorySeparatorChar)
    }).Count -gt 0) { return $null }
    $allowed = @($AllowedPresentationPaths | ForEach-Object {
      try { [IO.Path]::GetFullPath([string]$_) } catch { $null }
    } | Where-Object { $_ })
    if ($allowed.Count -eq 0) { return $null }
    $oneDriveRoots = @(@($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial) | Where-Object { $_ } | Select-Object -Unique)
    $relativePath = [IO.Path]::Combine([string[]]$relativeSegments)
    foreach ($oneDriveRoot in $oneDriveRoots) {
      $rootPath = [IO.Path]::GetFullPath($oneDriveRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
      $candidate = [IO.Path]::GetFullPath((Join-Path $rootPath $relativePath))
      if (-not $candidate.StartsWith("$rootPath$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) { continue }
      if ($allowed -contains $candidate) { return $candidate }
    }
  } catch { return $null }
  return $null
}
