@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao foi encontrado. Instale o Node.js 24 ou superior e tente novamente.
  pause
  exit /b 1
)

if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
  echo O arquivo .env foi criado. A demonstracao funciona offline, sem chaves de API.
)

if not exist "node_modules\express\package.json" (
  echo Instalando dependencias...
  call npm.cmd ci
  if errorlevel 1 (
    echo Nao foi possivel instalar as dependencias.
    pause
    exit /b 1
  )
)

echo Quando o servidor iniciar, acesse http://localhost:3000 no navegador.
call npm.cmd start

if errorlevel 1 pause
endlocal
