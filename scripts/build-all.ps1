# Llama Launcher - cross-platform release build script.
# Builds single binaries for Windows / Linux / macOS into ./dist.
# NOTE: keep this file ASCII-only so PowerShell 5.1 parses it without a BOM.
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

$builds = @(
    @{ OS = "windows"; Arch = "amd64"; Ext = ".exe" },
    @{ OS = "linux";   Arch = "amd64"; Ext = "" },
    @{ OS = "darwin";  Arch = "arm64"; Ext = "" }
)
$outDir = Join-Path $root "dist"
New-Item -ItemType Directory -Force $outDir | Out-Null

foreach ($b in $builds) {
    $env:GOOS = $b.OS
    $env:GOARCH = $b.Arch
    $name = "llama-launcher-$($b.OS)-$($b.Arch)$($b.Ext)"
    Write-Host "Building $name ..."
    go build -trimpath -ldflags "-s -w" -o (Join-Path $outDir $name) ./cmd/server
    if ($LASTEXITCODE -ne 0) { throw "build failed for $($b.OS)/$($b.Arch)" }
}
Remove-Item Env:GOOS -ErrorAction SilentlyContinue
Remove-Item Env:GOARCH -ErrorAction SilentlyContinue

Write-Host "Done. Artifacts in $outDir"
Get-ChildItem $outDir | ForEach-Object { "  $($_.Name)  $([math]::Round($_.Length/1MB,2)) MB" }
