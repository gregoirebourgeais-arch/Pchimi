@echo off
setlocal enabledelayedexpansion
cd /d %~dp0

echo ======================================
echo   Publication vers GitHub (Windows)
echo ======================================

where git >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Git n'est pas installe.
  echo Installe Git: https://git-scm.com/download/win
  pause
  exit /b 1
)

for /f "delims=" %%R in ('git remote') do set HAS_REMOTE=1
if not defined HAS_REMOTE (
  echo [ERREUR] Aucun remote configure.
  echo Execute d'abord:
  echo   git remote add origin https://github.com/TON_COMPTE/TON_REPO.git
  pause
  exit /b 1
)

for /f "delims=" %%B in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%B

echo Branche detectee: %BRANCH%
echo.
echo Etat actuel:
git status --short
echo.

git add .
git commit -m "Mise a jour menu planner" >nul 2>nul

echo Push en cours...
git push -u origin %BRANCH%
if errorlevel 1 (
  echo.
  echo [ERREUR] Le push a echoue.
  echo Causes probables:
  echo 1) Tu n'es pas connecte a GitHub
  echo 2) Tu n'as pas les droits sur le repo
  echo 3) Le token GitHub est manquant/expire
  echo.
  echo Solution rapide:
  echo - Ouvre GitHub Desktop puis reconnecte ton compte
  echo - Reessaie ce script
  pause
  exit /b 1
)

echo.
echo [OK] Push termine.
echo Ouvre maintenant ton repo GitHub pour creer la Pull Request.
pause
endlocal
