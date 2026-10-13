@echo off
REM ============================================================================
REM  Build the Phase-1 spike (process-loopback capture, EXCLUDE mode).
REM
REM  Requires VS Build Tools with:
REM     Microsoft.VisualStudio.Component.VC.Tools.x86.x64
REM     Microsoft.VisualStudio.Component.Windows11SDK.22621
REM
REM  Usage:  native\spike\build.cmd
REM
REM  ---- two traps deliberately avoided here --------------------------------
REM  1. Pure ASCII. .cmd files are read in the OEM codepage; non-ASCII text
REM     turns into garbage and can break parsing.
REM  2. NO parenthesised if-blocks. This machine's VS path contains
REM     "Program Files (x86)" - the ")" inside it closes the block early and
REM     cmd dies with "\Microsoft was unexpected at this time".
REM     Labels + goto instead.
REM ============================================================================
setlocal

set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

if not exist "%VCVARS%" goto :novc

call "%VCVARS%" >nul
if errorlevel 1 goto :nover

cd /d "%~dp0"

echo Compiling spike.exe ...
REM  /source-charset:utf-8  --- needed because spike.cpp has Chinese comments and
REM  this file is saved as UTF-8 with BOM. Without it MSVC reads the source in the
REM  system codepage (GBK here), the Chinese turns into garbage, and the garbage
REM  breaks the parser with very confusing errors.
REM  Note: execution charset is left alone, so printf output stays in the console
REM  codepage and displays correctly.
REM  mmdevapi.lib provides the import symbol for ActivateAudioInterfaceAsync.
REM  Without it: LNK2019 unresolved external symbol ActivateAudioInterfaceAsync.
REM  /execution-charset:utf-8  --- makes the program's printf output UTF-8 too,
REM  so it reads correctly in modern terminals (and in the DSH harness, which
REM  decodes native output as UTF-8). In an old cmd window you may need
REM  "chcp 65001" first.
cl /nologo /std:c++17 /EHsc /O2 /W3 /source-charset:utf-8 /execution-charset:utf-8 spike.cpp /Fe:spike.exe ole32.lib oleaut32.lib uuid.lib mmdevapi.lib
if errorlevel 1 goto :nocompile

echo.
echo Build OK:  %~dp0spike.exe
echo.
echo Next:
echo    spike.exe --list
echo    spike.exe --exclude ^<pid^> --sec 10
exit /b 0

:novc
echo [ERROR] vcvars64.bat not found:
echo         %VCVARS%
echo         Install VS Build Tools with the VCTools workload first.
exit /b 1

:nover
echo [ERROR] vcvars64.bat failed.
exit /b 1

:nocompile
echo.
echo [ERROR] Compile failed - see the messages above.
exit /b 1
