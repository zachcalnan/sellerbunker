$ErrorActionPreference = 'Stop'

Set-Location (Split-Path $PSScriptRoot -Parent)

function Test-DockerDaemon {
    $null = docker info 2>&1
    return $LASTEXITCODE -eq 0
}

if (-not (Test-DockerDaemon)) {
    Write-Host 'Docker is not running. Starting Docker Desktop...'

    $started = $false
    $null = docker desktop start 2>&1
    if ($LASTEXITCODE -eq 0) {
        $started = $true
    } else {
        $dockerDesktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
        if (Test-Path $dockerDesktop) {
            Start-Process $dockerDesktop | Out-Null
            $started = $true
        }
    }

    if (-not $started) {
        Write-Error 'Docker Desktop is not installed. Install it from https://www.docker.com/products/docker-desktop/'
        exit 1
    }

    $timeoutSec = 120
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-DockerDaemon) {
            Write-Host 'Docker is ready.'
            break
        }
        Start-Sleep -Seconds 2
        Write-Host 'Waiting for Docker...'
    }

    if (-not (Test-DockerDaemon)) {
        Write-Error "Docker did not become ready within ${timeoutSec}s. Open Docker Desktop manually and try again."
        exit 1
    }
}

Write-Host 'Starting Postgres and Redis...'
docker compose up -d --wait
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Host 'Postgres and Redis are ready.'
