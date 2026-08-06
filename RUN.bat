@echo off
setlocal EnableExtensions

cd /d "%~dp0"
title Oref Command Center

where node.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or is not available in PATH.
    echo Run INSTALL_AND_RUN.bat first.
    pause
    exit /b 1
)

for /f "delims=" %%V in ('node.exe -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR (
    echo [ERROR] Could not detect the Node.js version.
    pause
    exit /b 1
)
if %NODE_MAJOR% LSS 20 (
    echo [ERROR] Node.js 20 or newer is required. Detected major version %NODE_MAJOR%.
    echo Run INSTALL_AND_RUN.bat to install or upgrade Node.js.
    pause
    exit /b 1
)

if not exist ".env" (
    echo [SETUP] Creating .env from .env.example...
    copy /Y ".env.example" ".env" >nul
)

if not exist "node_modules" (
    echo [SETUP] Dependencies are missing. Running npm install...
    call npm.cmd install --no-audit --no-fund
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo [START] Starting Oref Command Center...
echo [INFO] The dashboard will open automatically when ready.
echo [INFO] Press Ctrl+C in this window to stop the server.
echo.

start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\windows\open-dashboard.ps1"
call npm.cmd start
set "APP_EXIT=%ERRORLEVEL%"

echo.
echo [STOPPED] Server exit code: %APP_EXIT%
pause
exit /b %APP_EXIT%
