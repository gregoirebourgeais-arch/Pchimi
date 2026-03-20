#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"

echo "Lancement frontend React sur http://localhost:3000"
cd "$FRONTEND_DIR"
npm install
npm start
