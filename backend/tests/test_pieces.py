import sys
import types

from app import pieces as P


def test_svg_check():
    ok = b'<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/><path d="M0 0"/></svg>'
    assert P.check_svg(ok)
    assert P.check_svg(b'<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA"/></svg>')
    for bad in (b'<svg><script>alert(1)</script></svg>', b'<svg onload="x()"></svg>', b'<svg><a href="https://x.y">a</a></svg>',
                b'<svg><use xlink:href="http://x/y.svg#a"/></svg>', b'<svg><foreignObject/></svg>', b'<html>nope</html>',
                b'<svg>' + b' ' * P.MAX_BYTES + b'</svg>', b''):
        assert not P.check_svg(bad), bad[:40]


def test_files_only_for_known_sets_and_names(tmp_path, monkeypatch):
    monkeypatch.setattr(P, "DIR", tmp_path)
    (tmp_path / "merida").mkdir()
    for f in P.FILES:
        (tmp_path / "merida" / f"{f}.svg").write_bytes(b"<svg/>")
    assert P.downloaded("merida") and P.file("merida", "wK")
    assert P.file("merida", "../x") is None and P.file("..", "wK") is None and P.file("merida", "wX") is None
    assert next(s for s in P.listing()["sets"] if s["id"] == "merida")["downloaded"]
    P.remove("merida")
    assert not P.downloaded("merida")


def test_download_keeps_nothing_on_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(P, "DIR", tmp_path)

    class Resp:
        def __init__(self, ok): self.status_code, self.content = (200, b"<svg/>") if ok else (404, b"")

    class Client:
        def __init__(self, *a, **k): self.n = 0
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url):
            return Resp("bP" not in url)          # the last file is missing everywhere

    fake = types.SimpleNamespace(Client=Client, Timeout=lambda *a, **k: None, HTTPError=Exception)
    monkeypatch.setitem(sys.modules, "httpx", fake)
    try:
        P.download("merida")
        raise AssertionError("should fail")
    except RuntimeError:
        pass
    assert not (tmp_path / "merida").exists() and not any(tmp_path.iterdir())
