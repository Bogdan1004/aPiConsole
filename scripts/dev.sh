#!/usr/bin/env bash
# Runs the hub with auto-reload for development. Open http://localhost:8420 in a browser.
# Tip: http://localhost:8420/?profile=bogdan&screen=movies skips the boot screen.
set -euo pipefail
cd "$(dirname "$0")/../hub"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt; }
exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port "${APISTATION_PORT:-8420}" --reload --reload-dir app
