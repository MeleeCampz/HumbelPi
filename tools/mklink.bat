@echo off
rem Windows only: give this clone a node_modules with pi's own two packages, so
rem `npx tsc -p tools/tsconfig.check.json` and the tests resolve them without
rem installing anything. Junctions (like symlinks on Linux), never committed:
rem .gitignore keeps node_modules/ out of git.
rem
rem Requires developer mode (or an elevated shell) for mklink /J.
setlocal
set PIROOT=%APPDATA%\npm\node_modules\@earendil-works\pi-coding-agent
if not exist "%PIROOT%" (
  echo pi-coding-agent not found under %APPDATA%\npm\node_modules — install pi first.
  exit /b 1
)
if not exist "node_modules\@earendil-works" mkdir "node_modules\@earendil-works"
mklink /J "node_modules\@earendil-works\pi-coding-agent" "%PIROOT%" >nul
mklink /J "node_modules\@earendil-works\pi-tui" "%PIROOT%\node_modules\@earendil-works\pi-tui" >nul
echo node_modules\@earendil-works\{pi-coding-agent,pi-tui} junctions ready.
