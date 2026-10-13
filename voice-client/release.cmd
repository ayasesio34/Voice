@echo off
REM ============================================================
REM  Build + publish -- double-click this to ship a new version
REM
REM  Does three things:
REM    1. npm run dist           build (installer + latest.yml)
REM    2. npm run publish:update upload to the update server
REM
REM  Prereq: version in package.json already bumped, CHANGELOG updated.
REM
REM  NOTE: if you see "Cannot create symbolic link",
REM        run this as Administrator (right-click - Run as administrator).
REM
REM  ------------------------------------------------------------
REM  IMPORTANT: keep this file PURE ASCII with CRLF line endings.
REM    cmd.exe reads it using the console code page (GBK on zh-CN), so
REM    UTF-8 Chinese text gets mis-decoded and can split a command in
REM    half. Symptom: garbage "... is not an internal or external
REM    command", and things like electron-builder appearing truncated.
REM    That is why all comments here are in English.
REM  ------------------------------------------------------------
REM ============================================================

cd /d "%~dp0"

REM --- Encoding guard ------------------------------------------------------
REM .cmd must stay PURE ASCII: cmd.exe reads it in the OEM codepage, and
REM UTF-8 Chinese comments get mis-decoded, which can split a command in half.
REM The guard lives in the server project; skip quietly if it is not there.
if exist "..\voice-server\check-cmd-ascii.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "..\voice-server\check-cmd-ascii.ps1"
  if errorlevel 1 goto fail
)

REM electron-builder downloads nsis / winCodeSign from GitHub, which often
REM fails from mainland China -- use the npmmirror mirror instead.
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

echo.
echo   [1/2] Building...
echo.
call npm run dist
if errorlevel 1 goto fail

echo.
echo   [2/2] Uploading to update server...
echo.
call npm run publish:update
if errorlevel 1 goto fail

echo.
echo   Done. New version is live.
echo.
pause
exit /b 0

:fail
echo.
echo   FAILED. See the messages above.
echo.
pause
exit /b 1
