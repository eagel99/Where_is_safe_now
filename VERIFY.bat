@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Oref Command Center - Verify

where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm was not found. Run INSTALL_AND_RUN.bat first.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [ERROR] Dependencies are not installed. Run INSTALL_AND_RUN.bat first.
    pause
    exit /b 1
)

call npm.cmd run verify
set "VERIFY_EXIT=%ERRORLEVEL%"
echo.
if "%VERIFY_EXIT%"=="0" (
    echo [OK] All checks passed.
) else (
    echo [ERROR] Verification failed with code %VERIFY_EXIT%.
)
pause
exit /b %VERIFY_EXIT%
