$ErrorActionPreference = 'SilentlyContinue'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$envFile = Join-Path $projectRoot '.env'
$port = 3000

if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*PORT\s*=\s*["'']?(\d+)["'']?\s*$') {
            $port = [int]$Matches[1]
            break
        }
    }
}

$baseUrl = "http://localhost:$port"
$healthUrl = "$baseUrl/api/v1/health"

for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
        $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 1
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
            Start-Process $baseUrl
            exit 0
        }
    } catch {
        Start-Sleep -Seconds 1
    }
}

# Fallback: open the dashboard even if the health check did not answer in time.
Start-Process $baseUrl
exit 0
