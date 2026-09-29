# sbxpi — launcher shim for PowerShell (any version, any host).
# Self-locating: no paths to maintain, the repo can live anywhere.
# Put this directory (…\HumbelPi\bin) on your PATH and run `sbxpi` from any
# folder. See README → "Real sandbox (Docker Sandboxes / sbx)".
$gitBash = 'C:\Program Files\Git\usr\bin\bash.exe'
# Git Bash first: other bashes on PATH (e.g. WSL's System32\bash.exe) don't
# understand the /c/... path form the scripts use.
$bash = if (Test-Path $gitBash) { $gitBash } else { (Get-Command bash.exe -ErrorAction SilentlyContinue).Source }
if (-not $bash) { Write-Error 'sbxpi: no bash found. Install Git for Windows.'; exit 1 }
& $bash (Join-Path $PSScriptRoot '..\tools\sbx-pi.sh') @args
exit $LASTEXITCODE
