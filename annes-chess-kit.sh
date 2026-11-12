#!/usr/bin/env sh
# Start Anne's Chess Kit on macOS / Linux. The first run sets up a Python environment in .venv.
# Stop it with Ctrl+C. Options are passed on to run.py (e.g. --browser, --port 8800).
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Setting up the Python environment…"
  python3 -m venv .venv
  .venv/bin/python -m pip install -q -r requirements.txt
fi
exec .venv/bin/python run.py "$@"
