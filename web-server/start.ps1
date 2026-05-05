# start.ps1 - launches the camera server + Cloudflare Quick Tunnel

$ErrorActionPreference = 'Stop'
$ProjectDir = $PSScriptRoot
$CloudflaredExe = Join-Path $ProjectDir 'cloudflared.exe'

# --- 1. Download cloudflared if missing ---
if (-not (Test-Path $CloudflaredExe)) {
    Write-Host "cloudflared not found - downloading..." -ForegroundColor Yellow
    $url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    Invoke-WebRequest -Uri $url -OutFile $CloudflaredExe -UseBasicParsing
    Write-Host "cloudflared downloaded." -ForegroundColor Green
}

# --- 2. Start the Node.js server in a new window ---
$nodeJob = Start-Process -FilePath 'node' `
    -ArgumentList 'server.js' `
    -WorkingDirectory $ProjectDir `
    -PassThru -NoNewWindow

Write-Host "Node server started (PID $($nodeJob.Id))" -ForegroundColor Cyan
Start-Sleep -Seconds 2

# --- 3. Start cloudflared quick tunnel, capture output ---
Write-Host ""
Write-Host "Starting Cloudflare Quick Tunnel..." -ForegroundColor Yellow
Write-Host "(waiting for tunnel URL - this takes ~5 seconds)" -ForegroundColor Gray
Write-Host ""

$tunnelLog = Join-Path $ProjectDir 'tunnel.log'
$cfProc = Start-Process -FilePath $CloudflaredExe `
    -ArgumentList 'tunnel','--url','http://localhost:3000','--no-autoupdate' `
    -WorkingDirectory $ProjectDir `
    -RedirectStandardOutput $tunnelLog `
    -RedirectStandardError $tunnelLog `
    -PassThru -NoNewWindow

# Poll the log until the trycloudflare URL appears
$timeout = 30
$elapsed = 0
$tunnelUrl = $null
while ($elapsed -lt $timeout -and -not $tunnelUrl) {
    Start-Sleep -Seconds 1
    $elapsed++
    if (Test-Path $tunnelLog) {
        $content = Get-Content $tunnelLog -Raw -ErrorAction SilentlyContinue
        if ($content -match 'https://[a-z0-9\-]+\.trycloudflare\.com') {
            $tunnelUrl = $Matches[0]
        }
    }
}

if ($tunnelUrl) {
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Green
    Write-Host "  TUNNEL READY - open this on your phone:" -ForegroundColor Green
    Write-Host ""
    Write-Host "  $tunnelUrl" -ForegroundColor White
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Frames save to: img/IMG_4389.jpeg every 15 s" -ForegroundColor Gray
    Write-Host "Press Ctrl+C to stop everything." -ForegroundColor Gray
} else {
    Write-Host "Tunnel URL not detected within $timeout s - check tunnel.log" -ForegroundColor Red
    Get-Content $tunnelLog -ErrorAction SilentlyContinue | Select-Object -Last 20
}

# Keep running; Ctrl+C will trigger the finally block
try {
    Wait-Process -Id $nodeJob.Id
} finally {
    Stop-Process -Id $nodeJob.Id -ErrorAction SilentlyContinue
    Stop-Process -Id $cfProc.Id  -ErrorAction SilentlyContinue
    Remove-Item $tunnelLog -ErrorAction SilentlyContinue
    Write-Host "Stopped." -ForegroundColor Yellow
}
