@echo off
setlocal
cd /d %~dp0

echo Lancement application...
start "Menu Planner UI" cmd /k "cd frontend && npm install && npm start"

timeout /t 6 /nobreak >nul
start http://localhost:3000
endlocal
