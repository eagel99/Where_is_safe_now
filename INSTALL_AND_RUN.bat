@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"
title Oref Command Center - Install and Run

set "MIN_NODE_MAJOR=20"
set "NODE_MAJOR="

call :banner
call :check_node
if errorlevel 1 goto :failed

call :check_npm
if errorlevel 1 goto :failed

if not exist ".env" (
    echo [SETUP] Creating .env from .env.example...
    copy /Y ".env.example" ".env" >nul
    if errorlevel 1 (
        echo [ERROR] Could not create .env.
        goto :failed
    )
) else (
    echo [SETUP] Existing .env found, keeping it unchanged.
)

echo.
echo [SETUP] Installing Node.js dependencies...
call npm.cmd install --no-audit --no-fund
if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    echo Check your internet connection, proxy, firewall, and npm registry settings.
    echo Current registry:
    call npm.cmd config get registry
    goto :failed
)

echo.
echo [VERIFY] Running syntax checks and automated tests...
call npm.cmd run verify
if errorlevel 1 (
    echo.
    echo [ERROR] Verification failed. The server was not started.
    goto :failed
)

echo.
echo [READY] Installation and tests completed successfully.
echo [START] Starting Oref Command Center...
echo [INFO] The dashboard will open automatically when the server is ready.
echo [INFO] Press Ctrl+C in this window to stop the server.
echo.

start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\windows\open-dashboard.ps1"
call npm.cmd start
set "APP_EXIT=%ERRORLEVEL%"

echo.
if "%APP_EXIT%"=="0" (
    echo [STOPPED] The server stopped normally.
) else (
    echo [ERROR] The server exited with code %APP_EXIT%.
)
pause
exit /b %APP_EXIT%

:check_node
where node.exe >nul 2>&1
if not errorlevel 1 (
    for /f "delims=" %%V in ('node.exe -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%V"
)

if defined NODE_MAJOR (
    if !NODE_MAJOR! GEQ %MIN_NODE_MAJOR% (
        for /f "delims=" %%V in ('node.exe --version') do echo [OK] Node.js %%V detected.
        exit /b 0
    )
    echo [WARN] Node.js major version !NODE_MAJOR! is too old. Version %MIN_NODE_MAJOR% or newer is required.
) else (
    echo [WARN] Node.js was not found.
)

echo [SETUP] Attempting to install the current Node.js LTS release with WinGet...
where winget.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] WinGet is not available on this Windows installation.
    echo Install Node.js 20 or newer from the official Node.js website, then run this file again.
    exit /b 1
)

winget.exe install --exact --id OpenJS.NodeJS.LTS --source winget --accept-package-agreements --accept-source-agreements --silent
if errorlevel 1 (
    echo [WARN] WinGet install returned an error. Trying an upgrade instead...
    winget.exe upgrade --exact --id OpenJS.NodeJS.LTS --source winget --accept-package-agreements --accept-source-agreements --silent
)

rem Refresh the common Node.js paths for this running CMD session.
set "PATH=%ProgramFiles%\nodejs;%AppData%\npm;%LocalAppData%\Programs\nodejs;%PATH%"
set "NODE_MAJOR="
where node.exe >nul 2>&1
if not errorlevel 1 (
    for /f "delims=" %%V in ('node.exe -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%V"
)

if not defined NODE_MAJOR (
    echo [ERROR] Node.js installation finished, but node.exe is not visible in this CMD session.
    echo Close this window and run INSTALL_AND_RUN.bat again.
    exit /b 1
)

if !NODE_MAJOR! LSS %MIN_NODE_MAJOR% (
    echo [ERROR] Node.js is still older than version %MIN_NODE_MAJOR%.
    echo Restart Windows or install a newer Node.js LTS release, then run this file again.
    exit /b 1
)

for /f "delims=" %%V in ('node.exe --version') do echo [OK] Node.js %%V installed.
exit /b 0

:check_npm
where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm.cmd was not found. Reinstall Node.js, then run this file again.
    exit /b 1
)
for /f "delims=" %%V in ('npm.cmd --version') do echo [OK] npm %%V detected.
exit /b 0

:banner
echo ============================================================
echo              OREF COMMAND CENTER FOR WINDOWS
echo ============================================================
echo This installer will:
echo   1. Check or install Node.js %MIN_NODE_MAJOR%+
echo   2. Create the local .env file when missing
echo   3. Install npm dependencies
echo   4. Run verification tests
echo   5. Start the server and open the dashboard
echo ============================================================
echo.
exit /b 0

:failed
echo.
echo [FAILED] Setup was not completed.
pause
exit /b 1
