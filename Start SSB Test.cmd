@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "SSB_NODE="
if exist ".local\node-path.txt" set /p "SSB_NODE="<".local\node-path.txt"
if defined SSB_NODE if exist "%SSB_NODE%" goto run
where.exe node.exe >nul 2>nul
if not errorlevel 1 (
  set "SSB_NODE=node.exe"
  goto run
)
if exist "%ProgramFiles%\nodejs\node.exe" (
  set "SSB_NODE=%ProgramFiles%\nodejs\node.exe"
  goto run
)
echo Требуется Node.js 24 LTS. Откройте docs\LOCAL_DEVELOPMENT.md.
pause
exit /b 1

:run
"%SSB_NODE%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 (
  echo Для тестовой среды требуется Node.js 24 или новее. См. docs\LOCAL_DEVELOPMENT.md.
  pause
  exit /b 1
)
if not exist "node_modules\esbuild\package.json" (
  echo Зависимости проекта не установлены. Выполните pnpm install --frozen-lockfile.
  pause
  exit /b 1
)
"%SSB_NODE%" "scripts\dev-server.mjs" --open
if errorlevel 1 (
  pause
  exit /b 1
)
