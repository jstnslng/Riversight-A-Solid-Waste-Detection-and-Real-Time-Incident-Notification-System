# Serve the existing static website locally; start the AI bridge separately.
$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $repositoryRoot
try {
    Write-Host 'RiverSight: http://127.0.0.1:8000/'
    Write-Host 'Waste Detection: http://127.0.0.1:8000/lib/monitoring/Waste-Management.html'
    Write-Host 'Stop with Ctrl+C. Start the segmentation bridge in a separate terminal.'
    python -m http.server 8000 --bind 127.0.0.1
    if ($LASTEXITCODE -ne 0) { throw 'Local website server exited unsuccessfully.' }
} finally {
    Pop-Location
}
