$ErrorActionPreference = 'Stop'

$url = 'http://localhost:3000'
$timeoutSec = 180
$deadline = (Get-Date).AddSeconds($timeoutSec)

Write-Host "Waiting for $url ..."

while ((Get-Date) -lt $deadline) {
    try {
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        if ($response.StatusCode -ge 200) {
            Write-Host "Opening $url"
            Start-Process $url
            exit 0
        }
    } catch {
        # Server not ready yet.
    }
    Start-Sleep -Seconds 2
}

Write-Error "App did not become ready at $url within ${timeoutSec}s."
exit 1
