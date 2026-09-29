@echo off
rem sbxpi - launcher shim for cmd (PowerShell runs .cmd too).
rem Self-locating: no paths to maintain, the repo can live anywhere.
rem Put this directory (...HumbelPi\bin) on your PATH and run sbxpi from any
rem folder. See README -> "Real sandbox (Docker Sandboxes / sbx)".
set "GITBASH=C:\Program Files\Git\usr\bin\bash.exe"
if exist "%GITBASH%" goto run
where bash >nul 2>nul || (echo sbxpi: no bash found. Install Git for Windows. & exit /b 1)
set "GITBASH=bash"
:run
"%GITBASH%" "%~dp0..\tools\sbx-pi.sh" %*
