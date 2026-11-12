# Contributing

Bug reports and pull requests are welcome. Please open an issue first for larger changes.

## Set up

```bash
python -m venv .venv
.venv/bin/pip install -r requirements-dev.txt        # Windows: .venv\Scripts\pip
cd frontend && npm ci
```

Put a Stockfish binary into `engine/` (see `engine/README.md`).

## Work on it

```bash
.venv/bin/python run.py --no-open --keep-running    # API + built UI on http://127.0.0.1:8765
cd frontend && npm run dev                          # UI with hot reload on http://localhost:5173 (proxies /api)
```

## Before you open a pull request

```bash
.venv/bin/python -m pytest backend    # backend tests (no engine needed)
cd frontend && npm run lint && npm run build
```

Keep changes focused, match the style of the surrounding code, and add a test for backend logic you change.
By contributing you agree that your contribution is licensed under the GPL-3.0-or-later, like the project.
