#!/usr/bin/env bash
set -euo pipefail

if ! command -v git >/dev/null 2>&1; then
  echo "Git n'est pas installe."
  exit 1
fi

if [[ -z "$(git remote -v)" ]]; then
  echo "Aucun remote GitHub detecte."
  echo "Ajoute d'abord un remote: git remote add origin <url-github>"
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"

echo "Remote detecte:" 
git remote -v

echo "\nEtat de la branche $BRANCH:" 
git status --short

if [[ -n "$(git status --porcelain)" ]]; then
  echo "\nDes changements non commits existent."
  echo "Commit rapide en cours..."
  git add .
  git commit -m "Mise a jour menu planner" || true
fi

echo "\nPush vers GitHub..."
git push -u origin "$BRANCH"

echo "Termine. Ouvre GitHub pour creer la Pull Request."
