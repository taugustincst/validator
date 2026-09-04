@echo off
rem Double-click to start the eCW Security Settings Validator web UI on this computer.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
cd /d "%~dp0"
node bin\ecw-validate.js serve --open
pause
