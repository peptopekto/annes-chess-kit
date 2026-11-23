"""Start Anne's Chess Kit: the API + built UI on http://127.0.0.1:8765, opened in its own app window.

Started with pythonw.exe (AnnesChessKit.exe or its shortcut) there's no console: output goes to
userdata/app.log, and the app quits by itself when you close its window.
"""
import argparse
import json
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "backend"))  # from the source folder; the single-file exe has the app built in

HANDOFF_SECONDS = 5      # a window process that exits this fast handed the window to another browser process
PING_TIMEOUT = 180       # fallback: no ping from the window for this long → it's gone (background tabs ping slowly)


def _windowless() -> bool:
    return sys.stdout is None or Path(sys.executable).name.lower() == "pythonw.exe"


def _userdata() -> Path:
    from app.config import USERDATA  # honours CHESSKIT_USERDATA
    return USERDATA


def _log_to_file() -> None:
    """No console: send output to userdata/app.log (kept small)."""
    log = _userdata() / "app.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    if log.exists() and log.stat().st_size > 1_000_000:
        log.replace(log.with_suffix(".log.old"))
    f = open(log, "a", encoding="utf-8", buffering=1)  # noqa: SIM115 – lives as long as the process
    sys.stdout = sys.stderr = f
    print(f"\n--- Anne's Chess Kit started {time.strftime('%Y-%m-%d %H:%M:%S')} ---")


def _browser() -> str | None:
    for exe in ("msedge", "chrome", "google-chrome", "chromium"):
        path = shutil.which(exe) or _known_path(exe)
        if path:
            return path
    return None


def _known_path(exe: str) -> str | None:
    candidates = {
        "msedge": [r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                   r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"],
        "chrome": [r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                   r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"],
    }.get(exe, [])
    return next((c for c in candidates if Path(c).exists()), None)


def open_window(url: str, app_window: bool) -> subprocess.Popen | None:
    """Chromeless app window (Edge/Chrome "app" mode) with its own profile, so it is a separate process
    we can watch – closing it closes the app. Falls back to a normal browser tab."""
    if app_window:
        path = _browser()
        if path:
            profile = _userdata() / ".window"
            return subprocess.Popen([path, f"--app={url}", f"--user-data-dir={profile}", "--window-size=1440,920",
                                     "--no-first-run", "--no-default-browser-check"])
    webbrowser.open(url)
    return None


def wait_until_up(url: str) -> None:
    for _ in range(300):
        try:
            urllib.request.urlopen(url + "api/health", timeout=0.5)
            return
        except OSError:
            time.sleep(0.1)


def watch_window(server, proc: subprocess.Popen | None) -> None:
    """Stop the server once the window is gone: when its process exits, or (if the browser handed the
    window to another process, or there is none to watch) when it stops pinging."""
    from app import main as app_main
    started = time.monotonic()
    if proc is not None:
        proc.wait()
        if time.monotonic() - started > HANDOFF_SECONDS:
            print("Window closed – shutting down.")
            server.should_exit = True
            return
    # Fallback: heartbeat. Wait for the first ping, then quit when they stop.
    while not server.should_exit:
        time.sleep(5)
        last = app_main.LAST_PING[0]
        if last and time.monotonic() - last > PING_TIMEOUT:
            print("No window for a while – shutting down.")
            server.should_exit = True
            return


def _health(url: str) -> dict | None:
    """The running server's /api/health, or None when nothing is running."""
    try:
        with urllib.request.urlopen(url + "api/health", timeout=0.5) as r:
            return json.loads(r.read()) if r.status == 200 else None
    except (OSError, ValueError):
        return None


def _same_folder(running: dict) -> bool:
    """Is the running server this one (same folder, same data)? Another copy – the portable folder, an
    installed version – answers on the same address but shows *its* data, not yours."""
    root, data = running.get("root"), running.get("userdata")
    if not root or not data:
        return False  # too old to say: treat it as another copy (it gets restarted, which is harmless)
    try:
        from app.config import ROOT as APP_ROOT  # the exe's folder for the single-file app
        return Path(root).resolve() == APP_ROOT.resolve() and Path(data).resolve() == _userdata().resolve()
    except OSError:
        return False


def _stop_outdated(url: str) -> bool:
    """A server started before an update – or another copy of it – is running: ask it to stop.
    True once it's gone."""
    try:
        urllib.request.urlopen(urllib.request.Request(url + "api/shutdown", data=b"", method="POST"), timeout=2)
    except OSError:
        return False  # too old to know /api/shutdown: it has to be closed by hand
    for _ in range(40):
        time.sleep(0.25)
        if _health(url) is None:
            return True
    return False


def watch_shutdown(server) -> None:
    """Stop the server when /api/shutdown was called (an update is waiting to be started)."""
    from app import main as app_main
    while not server.should_exit:
        time.sleep(0.5)
        if app_main.SHUTDOWN[0]:
            print("Restarting for an update – shutting down.")
            server.should_exit = True


def main() -> None:
    windowless = _windowless()
    if windowless:
        _log_to_file()
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--browser", action="store_true", help="open a normal browser tab instead of an app window")
    parser.add_argument("--no-open", action="store_true")
    parser.add_argument("--keep-running", action="store_true", help="don't quit when the window is closed")
    args = parser.parse_args()

    import uvicorn

    from app.config import FRONTEND_DIST
    if not (FRONTEND_DIST / "index.html").exists():
        print("UI not built yet – run:  cd frontend && npm install && npm run build")

    url = f"http://127.0.0.1:{args.port}/"
    running = _health(url)
    if running is not None:
        # Started before an update (its code is older than the files now), or another copy of the app
        # (with other data) is on this address: stop it and start this one.
        other = not _same_folder(running)
        replace = other or running.get("outdated", True)
        if not (replace and _stop_outdated(url)):
            if other:
                print(f"Another copy of the app ({running.get('root', 'an older version')}) is running on {url} – "
                      "close all its windows and start this one again.")
            elif replace:
                print("An older version is still running – close all its windows and start it again to update.")
            else:
                print(f"Anne's Chess Kit is already running at {url} – opening a window.")
                if not args.no_open:
                    open_window(url, not args.browser)
            return
        print("Stopped the other copy – starting this one." if other else
              "Stopped the older version – starting the updated one.")

    config = uvicorn.Config("app.main:app", host="127.0.0.1", port=args.port, log_level="warning",
                            log_config=None if windowless else uvicorn.config.LOGGING_CONFIG)
    server = uvicorn.Server(config)

    def opener() -> None:
        wait_until_up(url)
        proc = open_window(url, not args.browser)
        # Without a console the window is the app: closing it quits the app. With a console, Ctrl+C does.
        if windowless and not args.keep_running:
            watch_window(server, proc)

    threading.Thread(target=watch_shutdown, args=(server,), daemon=True, name="shutdown").start()
    if not args.no_open:
        threading.Thread(target=opener, daemon=True, name="window").start()
    print(f"Anne's Chess Kit running at {url}" + ("" if windowless else "  (Ctrl+C to stop)"))
    server.run()


if __name__ == "__main__":
    main()
