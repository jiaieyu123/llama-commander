# Llama Commander - frontend mirror sync script.
# Mirrors internal/webui/dist (the go:embed source) to web/dist (external hosting copy).
# NOTE: keep this file ASCII-only so PowerShell 5.1 parses it without a BOM.
param(
    [string]$Source = "",
    [string]$Dest = ""
)
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $Source) { $Source = Join-Path $root "internal\webui\dist" }
if (-not $Dest)   { $Dest   = Join-Path $root "web\dist" }

Write-Host "Mirroring web assets: $Source -> $Dest"
if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -Recurse -Force (Join-Path $Source "*") $Dest
$count = (Get-ChildItem -Recurse -File $Dest | Measure-Object).Count
Write-Host "Done. Copied $count files."
