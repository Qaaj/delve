# One-command install for Windows + Docker Desktop. Run from inside this
# project directory (right-click -> "Run with PowerShell", or from a
# PowerShell prompt: .\install.ps1). Mirrors install.sh's logic exactly —
# see that file if you're comparing the two.
$ErrorActionPreference = "Stop"

function Test-CommandExists($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

if (-not (Test-CommandExists "docker")) {
    Write-Host "Docker isn't installed. Get Docker Desktop first: https://www.docker.com/products/docker-desktop/"
    Write-Host "Then run this script again."
    exit 1
}

docker compose version *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker is installed, but the 'docker compose' plugin isn't available."
    Write-Host "Docker Desktop includes it automatically -- try updating Docker Desktop."
    exit 1
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker is installed but doesn't seem to be running. Open Docker Desktop, wait for it to finish starting, then run this script again."
    exit 1
}

Write-Host "Building and starting delve..."
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host ""
Write-Host "Waiting for it to come up..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:4310/" -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        # Not up yet -- expected during startup, keep polling.
    }
    Start-Sleep -Seconds 1
}

Write-Host ""
Write-Host "Ready. Opening http://localhost:4310 -- you'll land on a short setup page"
Write-Host "asking for your Proton Bridge username/password (Bridge -> your account"
Write-Host "-> Mailbox configuration). Don't have Bridge installed yet? Get it here"
Write-Host "first, log in, then come back: https://proton.me/mail/bridge"
Write-Host ""

Start-Process "http://localhost:4310"
