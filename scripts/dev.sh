#!/usr/bin/env bash
# Starts the mix-maker API (:8090) and the web dev server (:5175).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "missing .env (SCHEMA_API_URL, SCHEMA_API_KEY) — see README"; exit 1; }
(cd api && cargo build -q)
(cd web && [ -d node_modules ] || npm install)
./api/target/debug/mix-maker-api &
(cd web && npx vite --port 5175) &
echo "mix-maker → http://localhost:5175"
wait
