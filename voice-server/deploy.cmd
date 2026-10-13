@echo off
REM Server deploy launcher.
REM Keep this file PURE ASCII -- cmd.exe reads .cmd in the OEM codepage and
REM Chinese comments here break it with ". was unexpected at this time".
REM All Chinese messages live in deploy.ps1 instead.

setlocal
cd /d "%~dp0"

REM --- Encoding guard -------------------------------------------------------
REM A .ps1 with Chinese text but NO UTF-8 BOM is read as ANSI by PowerShell 5.1,
REM which produces bogus parser errors that look like broken logic.
REM This has happened three times, always after an editor rewrote the file.
REM check-bom.ps1 is pure ASCII so it does not need a BOM itself.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-bom.ps1"
if not %ERRORLEVEL%==0 (
  echo.
  echo   Deploy aborted: fix the encoding of the files listed above.
  echo.
  pause
  endlocal
  exit /b 1
)

where pwsh >nul 2>nul
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
)

echo.
pause
endlocal
