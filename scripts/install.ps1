param(
  [string]$Version = "latest",
  [switch]$Setup,
  [switch]$NoSetup,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$NpmUserPrefix = Join-Path $HOME ".npm-global"

function Write-Log {
  param([string]$Message)
  Write-Host $Message
}

function Write-WarnLog {
  param([string]$Message)
  Write-Warning $Message
}

function Fail {
  param([string]$Message)
  throw "Error: $Message"
}

function Write-CommandOutput {
  param($Output)
  if ($null -eq $Output) {
    return
  }
  $Output | ForEach-Object {
    if ($null -ne $_ -and $_.ToString().Length -gt 0) {
      Write-Host $_
    }
  }
}

function Invoke-CommandStep {
  param(
    [string]$CommandName,
    [string[]]$Arguments
  )

  if ($DryRun) {
    Write-Log ("[dry-run] {0} {1}" -f $CommandName, ($Arguments -join " "))
    return [pscustomobject]@{
      ExitCode = 0
      Output   = @()
    }
  }

  $output = & $CommandName @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  return [pscustomobject]@{
    ExitCode = $exitCode
    Output   = $output
  }
}

function Ensure-Command {
  param(
    [string]$Name,
    [string]$Hint
  )

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Fail $Hint
  }
}

function Refresh-ProcessPathFromSystem {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @()
  if (-not [string]::IsNullOrWhiteSpace($machinePath)) {
    $parts += $machinePath
  }
  if (-not [string]::IsNullOrWhiteSpace($userPath)) {
    $parts += $userPath
  }
  if ($parts.Count -gt 0) {
    $env:Path = ($parts -join ";")
  }
}

function Get-NodeMajor {
  $raw = (node --version).Trim()
  if ($raw -match "^v(\d+)") {
    return [int]$matches[1]
  }
  Fail "Unable to parse Node.js version from '$raw'."
}

function Split-PathList {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return @()
  }
  return $Value -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
}

function Path-EntryExists {
  param(
    [string[]]$Entries,
    [string]$Candidate
  )

  $normalizedCandidate = $Candidate.TrimEnd("\").ToLowerInvariant()
  foreach ($entry in $Entries) {
    if ($entry.TrimEnd("\").ToLowerInvariant() -eq $normalizedCandidate) {
      return $true
    }
  }
  return $false
}

function Ensure-PathEntry {
  param([string]$PathEntry)

  if ([string]::IsNullOrWhiteSpace($PathEntry)) {
    return
  }

  $resolved = [System.IO.Path]::GetFullPath($PathEntry)

  $processEntries = Split-PathList $env:Path
  if (-not (Path-EntryExists -Entries $processEntries -Candidate $resolved)) {
    $env:Path = "{0};{1}" -f $resolved, $env:Path
    Write-Log "Added $resolved to PATH in current shell"
  } else {
    Write-Log "PATH already contains $resolved"
  }

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $userEntries = Split-PathList $userPath
  if (Path-EntryExists -Entries $userEntries -Candidate $resolved) {
    Write-Log "PATH already persisted in user environment"
    return
  }

  if ($DryRun) {
    Write-Log "[dry-run] Persist $resolved in user PATH"
    return
  }

  $newUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) {
    $resolved
  } else {
    "{0};{1}" -f $resolved, $userPath
  }
  [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
  Write-Log "Persisted $resolved in user PATH"
}

function Try-BootstrapNodeWithWinget {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-WarnLog "winget was not found. Cannot auto-install Node.js."
    return $false
  }

  Write-Log "Attempting to install Node.js LTS via winget..."
  $args = @(
    "install",
    "--id", "OpenJS.NodeJS.LTS",
    "-e",
    "--accept-package-agreements",
    "--accept-source-agreements"
  )

  $result = Invoke-CommandStep -CommandName "winget" -Arguments $args
  if ($result.ExitCode -ne 0) {
    $text = ($result.Output | Out-String).Trim()
    Write-WarnLog "winget Node.js install failed: $text"
    return $false
  }

  Write-CommandOutput -Output $result.Output
  if (-not $DryRun) {
    Refresh-ProcessPathFromSystem
  }
  return $true
}

function Ensure-SupportedNode {
  $hasNode = [bool](Get-Command node -ErrorAction SilentlyContinue)
  $hasNpm = [bool](Get-Command npm -ErrorAction SilentlyContinue)
  $needsBootstrap = $false

  if (-not $hasNode -or -not $hasNpm) {
    Write-WarnLog "Node.js/npm not found. Attempting bootstrap via winget."
    $needsBootstrap = $true
  } else {
    $major = Get-NodeMajor
    if ($major -ne 22 -and $major -ne 24) {
      Write-WarnLog ("Detected unsupported Node.js {0}. Attempting bootstrap via winget." -f (node --version))
      $needsBootstrap = $true
    }
  }

  if ($needsBootstrap) {
    [void](Try-BootstrapNodeWithWinget)
  }

  if ($DryRun -and (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue))) {
    Write-Log "Dry run: skipping strict Node.js/npm availability check."
    return
  }

  Ensure-Command -Name "node" -Hint "Node.js 22 or 24 is required. Install from https://nodejs.org/ and retry."
  Ensure-Command -Name "npm" -Hint "npm is required. Install Node.js 22 or 24 (includes npm) and retry."

  $currentMajor = Get-NodeMajor
  if ($currentMajor -ne 22 -and $currentMajor -ne 24) {
    Fail ("Detected Node.js {0}. PulSeed supports Node.js 22 or 24." -f (node --version))
  }
  Write-Log ("Detected Node.js {0}" -f (node --version))
}

function Is-PermissionInstallError {
  param([string]$Message)
  if ([string]::IsNullOrWhiteSpace($Message)) {
    return $false
  }
  return $Message -match "EACCES|EPERM|permission denied"
}

function Configure-NpmUserPrefix {
  Write-Log "Configuring npm user prefix at $NpmUserPrefix"
  if ($DryRun) {
    Write-Log "[dry-run] New-Item -ItemType Directory -Force -Path $NpmUserPrefix"
  } else {
    New-Item -ItemType Directory -Force -Path $NpmUserPrefix | Out-Null
  }

  $setPrefix = Invoke-CommandStep -CommandName "npm" -Arguments @("config", "set", "prefix", $NpmUserPrefix)
  if ($setPrefix.ExitCode -ne 0) {
    $text = ($setPrefix.Output | Out-String).Trim()
    Fail "Failed to set npm prefix: $text"
  }

  Ensure-PathEntry -PathEntry $NpmUserPrefix
  $binDir = Join-Path $NpmUserPrefix "bin"
  if (Test-Path $binDir) {
    Ensure-PathEntry -PathEntry $binDir
  }
}

function Install-PackageGlobal {
  param([string]$PackageSpec)

  Write-Log "Installing $PackageSpec globally with npm..."
  $result = Invoke-CommandStep -CommandName "npm" -Arguments @("install", "-g", $PackageSpec)
  if ($result.ExitCode -eq 0) {
    Write-CommandOutput -Output $result.Output
    return
  }

  $outputText = ($result.Output | Out-String).Trim()
  if (-not (Is-PermissionInstallError -Message $outputText)) {
    Fail "Global npm install failed: $outputText"
  }

  Write-WarnLog "Global npm install failed due to permissions. Retrying with user prefix."
  Configure-NpmUserPrefix
  $retry = Invoke-CommandStep -CommandName "npm" -Arguments @("install", "-g", $PackageSpec)
  if ($retry.ExitCode -ne 0) {
    $retryText = ($retry.Output | Out-String).Trim()
    Fail "Global npm install failed after user-prefix fallback: $retryText"
  }
  Write-CommandOutput -Output $retry.Output
}

function Get-NpmPathCandidates {
  $candidates = New-Object System.Collections.Generic.List[string]

  $prefixResult = Invoke-CommandStep -CommandName "npm" -Arguments @("config", "get", "prefix")
  if ($prefixResult.ExitCode -eq 0 -and $null -ne $prefixResult.Output) {
    $prefix = ($prefixResult.Output | Select-Object -Last 1).ToString().Trim()
    if (-not [string]::IsNullOrWhiteSpace($prefix) -and $prefix -ne "undefined") {
      $candidates.Add($prefix)
      $candidates.Add((Join-Path $prefix "bin"))
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
    $candidates.Add((Join-Path $env:APPDATA "npm"))
  }

  return $candidates | Select-Object -Unique
}

function Ensure-PulseedOnPath {
  if ($DryRun) {
    Write-Log "Dry run: skipping pulseed PATH checks."
    return
  }

  if (Get-Command pulseed -ErrorAction SilentlyContinue) {
    return
  }

  foreach ($candidate in Get-NpmPathCandidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) {
      continue
    }
    Ensure-PathEntry -PathEntry $candidate
    if (Get-Command pulseed -ErrorAction SilentlyContinue) {
      return
    }
  }

  Fail "Install completed but 'pulseed' is still not on PATH."
}

function Verify-Install {
  if ($DryRun) {
    Write-Log "Dry run: skipping post-install verification."
    return
  }

  $versionResult = Invoke-CommandStep -CommandName "pulseed" -Arguments @("--version")
  if ($versionResult.ExitCode -ne 0) {
    $text = ($versionResult.Output | Out-String).Trim()
    Fail "'pulseed --version' failed after install: $text"
  }
  $versionText = ($versionResult.Output | Out-String).Trim()
  Write-Log "pulseed --version: $versionText"

  Write-Log "Running 'pulseed doctor' (best-effort)..."
  $doctorResult = Invoke-CommandStep -CommandName "pulseed" -Arguments @("doctor")
  if ($doctorResult.ExitCode -eq 0) {
    Write-Log "pulseed doctor: OK"
  } else {
    Write-WarnLog "pulseed doctor reported issues. Continuing installer completion."
  }
  Write-CommandOutput -Output $doctorResult.Output
}

if ($Setup -and $NoSetup) {
  Fail "Use either --setup or --no-setup, not both."
}

Ensure-SupportedNode

$packageSpec = if ($Version -eq "latest") { "pulseed" } else { "pulseed@$Version" }
Install-PackageGlobal -PackageSpec $packageSpec
Ensure-PulseedOnPath
Verify-Install

$shouldRunSetup = if ($Setup) {
  $true
} elseif ($NoSetup) {
  $false
} else {
  [Environment]::UserInteractive
}

if ($shouldRunSetup) {
  Write-Log "Running: pulseed setup"
  $setupResult = Invoke-CommandStep -CommandName "pulseed" -Arguments @("setup")
  if ($setupResult.ExitCode -ne 0) {
    $setupText = ($setupResult.Output | Out-String).Trim()
    Fail "pulseed setup failed: $setupText"
  }
  Write-CommandOutput -Output $setupResult.Output
} else {
  Write-Log "Skipping setup. Run 'pulseed setup' later if needed."
}
