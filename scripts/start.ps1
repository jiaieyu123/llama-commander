# Llama Launcher - one-click start script.
# NOTE: keep this file ASCII-only so PowerShell 5.1 parses it without a BOM.
#
# Usage:
#   scripts\start.ps1               build-if-needed + start (default port 8114)
#   scripts\start.ps1 -NoBuild      start existing exe without rebuilding
#   scripts\start.ps1 -ForceBuild   force rebuild
#   scripts\start.ps1 -Port 8115    use another port
#   scripts\start.ps1 -NoBrowser    do not auto-open the browser
#   scripts\start.ps1 -Restart      stop an already-running instance and start fresh

param(
    [switch]$NoBuild,
    [switch]$ForceBuild,
    [int]$Port = 8114,
    [switch]$NoBrowser,
    [switch]$Restart
)
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

# 1) Ensure Go is available (portable SDK).
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    $goBin = "C:\Users\long\go-sdk\go\bin"
    if (Test-Path (Join-Path $goBin "go.exe")) {
        $env:Path = "$env:Path;$goBin"
    } else {
        Write-Host "[ERROR] Go not found. Install it or edit GO_BIN in start.ps1." -ForegroundColor Red
        exit 1
    }
}
$env:GOPROXY = "https://goproxy.cn,direct"

# 2) Decide whether to rebuild (skip when -NoBuild).
$exe = Join-Path $root "llama-launcher.exe"
$needBuild = $ForceBuild
if (-not $needBuild -and -not $NoBuild) {
    if (-not (Test-Path $exe)) {
        $needBuild = $true
    } else {
        $exeTime = (Get-Item $exe).LastWriteTime
        $newer = Get-ChildItem -Path internal,cmd -Recurse -File -ErrorAction SilentlyContinue |
                 Where-Object { $_.LastWriteTime -gt $exeTime } |
                 Select-Object -First 1
        if ($newer) { $needBuild = $true }
    }
}
if ($needBuild -and -not $NoBuild) {
    Write-Host "[BUILD] Syncing web assets and compiling..." -ForegroundColor Cyan
    powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\sync-web.ps1" | Out-Null
    go build -o llama-launcher.exe ./cmd/server
    if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] Build failed." -ForegroundColor Red; exit 1 }
    Write-Host "[OK] Build done." -ForegroundColor Green
} else {
    Write-Host "[SKIP] Using existing llama-launcher.exe (use -ForceBuild to rebuild)." -ForegroundColor DarkGray
}

# 3) Port conflict check.
$conn = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($conn) {
    $owner = $conn | Select-Object -First 1 -ExpandProperty OwningProcess
    $proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -match 'llama-launcher') {
        if ($Restart) {
            Write-Host "[RESTART] Stopping existing llama-launcher on port $Port (PID $owner)..." -ForegroundColor Yellow
            Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
            $wait = 0
            while ((Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) -and $wait -lt 5000) {
                Start-Sleep -Milliseconds 200
                $wait += 200
            }
        } else {
            Write-Host "[INFO] Llama Launcher is already running on port $Port." -ForegroundColor Green
            if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$Port" }
            Write-Host "[INFO] Opened the app. Use -Restart to stop it and start fresh." -ForegroundColor DarkGray
            exit 0
        }
    } else {
        Write-Host "[WARN] Port $Port is in use by another process ($($proc.ProcessName) PID $owner)." -ForegroundColor Yellow
        Write-Host "       Stop it, or run: scripts\start.ps1 -Port $($Port + 1)" -ForegroundColor Yellow
        exit 1
    }
}

# 4) Launch.
if (-not $NoBrowser) {
    Start-Process "http://127.0.0.1:$Port"
}
Write-Host "[OK] Starting Llama Launcher at http://127.0.0.1:$Port" -ForegroundColor Green
& .\llama-launcher.exe --port $Port
