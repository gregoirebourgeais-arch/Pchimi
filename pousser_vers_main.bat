@echo off
setlocal
cd /d %~dp0

echo Cette action pousse la branche courante vers origin/main.
set /p CONFIRM="Tape OUI pour continuer: "
if /I not "%CONFIRM%"=="OUI" (
  echo Annule.
  exit /b 1
)

where git >nul 2>nul
if errorlevel 1 (
  echo Git non installe.
  pause
  exit /b 1
)

for /f "delims=" %%B in ('git rev-parse --abbrev-ref HEAD') do set CURR=%%B

echo Branche actuelle: %CURR%
git add .
git commit -m "Sync main" >nul 2>nul

echo Push vers origin/main...
git push origin HEAD:main
if errorlevel 1 (
  echo Echec du push. Verifie droits/auth GitHub.
  pause
  exit /b 1
)

echo OK: les modifications sont maintenant sur main.
pause
endlocal
