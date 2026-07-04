@echo off
setlocal
set "APP_DIR=%~dp0"
cd /d "%APP_DIR%"

set "NODE_EXE="
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
if not defined NODE_EXE if exist "%userprofile%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%userprofile%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE (
  echo Node.js nao foi encontrado.
  choice /C YN /M "Queres abrir a pagina de instalacao do Node.js?"
  if errorlevel 2 exit /b 1
  start "" "https://nodejs.org/"
  exit /b 1
)

set "PYTHON_EXE="
for /f "delims=" %%I in ('where python 2^>nul') do if not defined PYTHON_EXE set "PYTHON_EXE=%%I"
if not defined PYTHON_EXE (
  for /f "delims=" %%I in ('where py 2^>nul') do if not defined PYTHON_EXE set "PYTHON_EXE=%%I -3"
)
if not defined PYTHON_EXE (
  echo Python nao foi encontrado.
  choice /C YN /M "Queres abrir a pagina de instalacao do Python?"
  if errorlevel 2 exit /b 1
  start "" "https://www.python.org/downloads/"
  exit /b 1
)

set "CODEX_EXE=%localappdata%\OpenAI\Codex\bin\codex.exe"
set "CODEX_READY=1"
if not exist "%CODEX_EXE%" (
  set "CODEX_READY=0"
)
if "%CODEX_READY%"=="1" (
  "%CODEX_EXE%" --help >nul 2>nul
  if errorlevel 1 set "CODEX_READY=0"
)

if "%CODEX_READY%"=="0" (
  echo Codex CLI nao foi validado neste sistema.
  choice /C YN /M "Queres abrir a pagina de instalacao do Codex agora?"
  if errorlevel 2 goto afterCodexPrompt
  start "" "https://openai.com/codex"
)

:afterCodexPrompt

if not exist "%APP_DIR%runs" mkdir "%APP_DIR%runs" >nul 2>nul

set "PYTHON_EXE=%PYTHON_EXE%"
set "WORKER_COMMAND=%NODE_EXE%"

start "Lead Prompt Lab" cmd /c ""%NODE_EXE%" server.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:41773"

endlocal
