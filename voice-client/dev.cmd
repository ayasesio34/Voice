@echo off
REM ============================================================
REM  Dev-mode launcher -- double-click to open the client
REM
REM  Code changes apply automatically:
REM    - renderer (src/renderer) -- hot reload, UI updates instantly
REM    - main / preload (src/main, src/preload) -- app restarts itself
REM
REM  Closing this console window closes the client.
REM  Press Ctrl+C or just close the window to stop.
REM
REM  NOTE: dev builds and packaged builds do NOT share local storage
REM        (dev pages come from http://localhost:5173, packaged from
REM        file://), so nickname / avatar / settings are stored apart.
REM
REM  ------------------------------------------------------------
REM  IMPORTANT: keep this file PURE ASCII with CRLF line endings.
REM    cmd.exe reads it using the console code page (GBK on zh-CN), so
REM    UTF-8 Chinese text gets mis-decoded and can split a command in
REM    half. That is why all comments here are in English.
REM  ------------------------------------------------------------
REM ============================================================

cd /d "%~dp0"

echo.
echo   Voice - starting dev mode...
echo   (close this window or press Ctrl+C to stop)
echo.

call npm run dev

echo.
echo   Dev server stopped.
pause
