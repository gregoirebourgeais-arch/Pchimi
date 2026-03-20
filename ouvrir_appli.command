#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
(
  cd "$ROOT_DIR/frontend"
  npm install
  npm start
) &

sleep 6
xdg-open "http://localhost:3000" >/dev/null 2>&1 || open "http://localhost:3000" >/dev/null 2>&1 || true
wait
