@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
title InkRead - local reading server

rem ============================================================
rem  InkRead launcher
rem
rem  KEEP THIS FILE PURE ASCII.
rem  cmd.exe cannot reliably parse a .bat that contains
rem  multi-byte characters: it loses sync inside the file and
rem  starts executing fragments of lines. Saving the file as
rem  GBK/ANSI works on a Chinese Windows but breaks the moment
rem  an editor writes it back as UTF-8. ASCII is safe on every
rem  locale, so all Chinese text lives in the web app itself.
rem
rem  Usage:
rem    start.bat             pick a free port (from 5173) + open browser
rem    start.bat 8080        use a specific port
rem    start.bat 8080 -n     specific port, do not open the browser
rem    start.bat -h          show help
rem ============================================================

cd /d "%~dp0"
set "ROOT=%CD%"
set "START_PORT=5173"
set "AUTO_OPEN=1"

:parse_args
if "%~1"=="" goto args_done
set "ARG=%~1"
set "ISNUM=0"
echo(!ARG!|findstr /r "^[0-9][0-9]*$" >nul
if not errorlevel 1 set "ISNUM=1"
if /i "!ARG!"=="-n"        ( set "AUTO_OPEN=0" & set "ISNUM=2" )
if /i "!ARG!"=="/n"        ( set "AUTO_OPEN=0" & set "ISNUM=2" )
if /i "!ARG!"=="--no-open" ( set "AUTO_OPEN=0" & set "ISNUM=2" )
if /i "!ARG!"=="-h"        goto usage
if /i "!ARG!"=="--help"    goto usage
if /i "!ARG!"=="/?"        goto usage
if "!ISNUM!"=="1" (
    set "START_PORT=!ARG!"
    set "LAST_PORT=!ARG!"
)
if "!ISNUM!"=="0" set "UNKNOWN=!UNKNOWN! !ARG!"
shift
goto parse_args

:args_done
if defined UNKNOWN echo   [WARN] Unknown option^(s^) ignored:!UNKNOWN!
if not defined LAST_PORT goto skip_port_check
set /a PORT_CHK=LAST_PORT 2>nul
if !PORT_CHK! lss 1 goto bad_port
if !PORT_CHK! gtr 65535 goto bad_port
:skip_port_check

if not exist "index.html" (
    echo   [ERROR] index.html not found in:
    echo           %ROOT%
    echo   Put start.bat next to index.html and run it again.
    goto die
)

rem ------------------------------------------------------------
rem  1. Pick a runtime: Node first (ships correct UTF-8 charset),
rem     fall back to Python.
rem ------------------------------------------------------------
set "KIND="
set "PYCMD="

node -e "process.exit(process.versions.node.split('.')[0] >= 18 ? 0 : 1)" >nul 2>&1
if not errorlevel 1 set "KIND=node"

if not defined KIND (
    py -3 -c "import sys" >nul 2>&1
    if not errorlevel 1 (
        set "KIND=python"
        set "PYCMD=py -3"
    )
)

if not defined KIND (
    python -c "import sys" >nul 2>&1
    if not errorlevel 1 (
        set "KIND=python"
        set "PYCMD=python"
    )
)

if not defined KIND (
    echo   [ERROR] Neither Node.js nor Python was found.
    echo           Node.js 18+ is recommended: https://nodejs.org/
    goto die
)

rem ------------------------------------------------------------
rem  2. Find a free port, starting at 5173.
rem     The probe must bind exactly like the real server does,
rem     otherwise an occupied port can be misdetected.
rem ------------------------------------------------------------
set "PORT="
set /a TRY=0

:scan
set /a CAND=START_PORT+TRY
call :is_port_free !CAND!
if "!FREE!"=="1" (
    set "PORT=!CAND!"
    goto have_port
)
set /a TRY+=1
if !TRY! lss 30 goto scan

echo   [ERROR] Ports !START_PORT! to !CAND! are all occupied.
echo           Try a specific one: start.bat 8090
goto die

:have_port
if not "!CAND!"=="!START_PORT!" echo   [INFO] Port !START_PORT! was busy, using !CAND! instead.

rem ------------------------------------------------------------
rem  3. Detect the LAN IP so the phone can reach the server.
rem ------------------------------------------------------------
set "LANIP="
set "IPFILE=%TEMP%\inkread-ip-%RANDOM%.txt"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $ips=@(); try { $ips += (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' -and $_.PrefixOrigin -ne 'WellKnown' } | ForEach-Object { $_.IPAddress }) } catch {}; if (-not $ips) { try { $ips += ([System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) | Where-Object { $_.AddressFamily -eq 'InterNetwork' } | ForEach-Object { $_.IPAddressToString }) } catch {} }; $priv = $ips | Where-Object { $_ -match '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)' }; if ($priv) { $priv | Select-Object -First 1 } elseif ($ips) { $ips | Select-Object -First 1 }" > "!IPFILE!" 2>nul
if exist "!IPFILE!" (
    set /p LANIP=<"!IPFILE!"
    del "!IPFILE!" >nul 2>&1
)

rem ------------------------------------------------------------
rem  4. Print the addresses.
rem ------------------------------------------------------------
echo.
echo  ==========================================================
echo    InkRead  -  local reading server is ready
echo  ==========================================================
echo    On this PC  : http://localhost:!PORT!/
if defined LANIP (
    echo    On phone    : http://!LANIP!:!PORT!/
    echo                  ^(same Wi-Fi^; "Add to Home Screen" gives you an app^)
) else (
    echo    On phone    : http://^<your-LAN-IP^>:!PORT!/
    echo                  ^(run ipconfig to find it^)
)
echo.
echo    Book list   : data/books.json
echo    Book files  : data/books/    drop .txt / .json / .json.gz here
echo    Storage     : books, progress and bookmarks live in browser IndexedDB
echo  ----------------------------------------------------------
if "!PYCMD!"=="" (
    echo    Runtime     : Node  ^(tools/serve.mjs^)   port !PORT!
) else (
    echo    Runtime     : !PYCMD!  ^(http.server^)   port !PORT!
)
echo    Press Ctrl+C to stop the server
echo  ==========================================================
echo.

rem ------------------------------------------------------------
rem  5. Open the browser shortly after the server starts.
rem ------------------------------------------------------------
if "!AUTO_OPEN!"=="1" (
    echo    Opening the browser in 2 seconds...
    start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:!PORT!/'"
    echo.
)

if /i "!KIND!"=="node" (
    node tools/serve.mjs !PORT!
) else (
    !PYCMD! -m http.server !PORT! --bind 0.0.0.0
)

:stop
echo.
echo  [INFO] Server stopped.
pause
exit /b 0

:die
echo.
pause
exit /b 1

:bad_port
echo   [ERROR] "!LAST_PORT!" is not a valid port. Use a number between 1 and 65535.
goto die

rem ------------------------------------------------------------
rem  Subroutine: is the port free?
rem  Node binds "::" (dual stack) with a bare listen(), so the
rem  probe does the same. Python is launched with --bind 0.0.0.0.
rem ------------------------------------------------------------
:is_port_free
set "FREE=0"
if /i "!KIND!"=="python" goto pf_python
node -e "const net=require('net');const s=net.createServer();s.on('error',()=>process.exit(1));s.listen(%1,()=>s.close(()=>process.exit(0)))" >nul 2>&1
if not errorlevel 1 set "FREE=1"
exit /b
:pf_python
!PYCMD! -c "import socket;s=socket.socket();s.bind(('0.0.0.0',%1));s.close()" >nul 2>&1
if not errorlevel 1 set "FREE=1"
exit /b

rem ------------------------------------------------------------
rem  Help
rem ------------------------------------------------------------
:usage
echo.
echo   InkRead  -  local reading server
echo.
echo     start.bat              pick a free port (from 5173) + open browser
echo     start.bat 8080         use port 8080
echo     start.bat 8080 -n      use port 8080, do not open the browser
echo     start.bat -h           show this help
echo.
echo   Editing a book file needs no restart; editing data/books.json
echo   just needs a page refresh in the browser.
echo.
pause
exit /b 0
