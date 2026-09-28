@echo off
setlocal EnableExtensions
set "HOST=%~1"
if "%HOST%"=="" set "HOST=codex"
set "LOGDIR=%USERPROFILE%\.config\jev-compaction"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
echo %DATE% %TIME% cmd started host=%HOST%>> "%LOGDIR%\last-run.log"

for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USERPATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "SYSPATH=%%B"
set "PATH=%USERPATH%;%SYSPATH%;%PATH%"

set "NODEEXE="
where node >nul 2>&1 && set "NODEEXE=node"
if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODEEXE=%LocalAppData%\Programs\nodejs\node.exe"
if not defined NODEEXE (
  echo %DATE% %TIME% node.exe not found>> "%LOGDIR%\last-run.log"
  echo {"continue":true,"systemMessage":"jev-compaction: node.exe was not found. Install Node.js, then restart the desktop app."}
  exit /b 0
)
echo %DATE% %TIME% using %NODEEXE%>> "%LOGDIR%\last-run.log"
"%NODEEXE%" "%~dp0hook.mjs" %HOST%
exit /b %ERRORLEVEL%
