#!/usr/bin/env bash
set -euo pipefail

echo "Cette action pousse la branche courante vers origin/main."
read -r -p "Tape OUI pour continuer: " CONFIRM
if [[ "$CONFIRM" != "OUI" ]]; then
  echo "Annulé"
  exit 1
fi

git add .
git commit -m "Sync main" || true
git push origin HEAD:main

echo "OK: les modifications sont sur main."
