# Prepare a portable CPU OCR runtime next to the application.
param([string]$Python = '', [string]$Target = '')
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $Target) { $Target = Join-Path $repo 'build\bin\ocr-runtime' }
if (-not $Python) {
    & uv python install 3.11
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.11 download failed' }
    $Python = (& uv python find 3.11).Trim()
}
$version = & $Python -c 'import sys; print("%d.%d" % sys.version_info[:2])'
if ($version -ne '3.11') { throw 'Please use a standalone Python 3.11 interpreter' }
$source = Split-Path -Parent $Python
New-Item -ItemType Directory -Force -Path $Target | Out-Null
if (([IO.Path]::GetFullPath($source)) -ne ([IO.Path]::GetFullPath($Target))) {
    Copy-Item -Path (Join-Path $source '*') -Destination $Target -Recurse -Force
}
$runtimePython = Join-Path $Target 'python.exe'
& uv pip install --break-system-packages --python $runtimePython -r (Join-Path $repo 'thirdparty\requirements-ocr.txt')
if ($LASTEXITCODE -ne 0) { throw 'OCR dependencies installation failed' }
Copy-Item (Join-Path $repo 'thirdparty\ocr_worker.py') (Join-Path (Split-Path -Parent $Target) 'ocr_worker.py') -Force
Write-Output "OCR runtime prepared: $runtimePython"
