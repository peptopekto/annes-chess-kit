"""Draw the app icon (teal circle with "!!") into app.ico – plain Python, no image library.

Run once: python scripts/make_icon.py  (writes app.ico next to run.py).
"""
import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOP, BOTTOM = (0x2E, 0xE6, 0xD6), (0x14, 0xA8, 0x9C)


def coverage(x: float, y: float) -> tuple[float, float]:
    """(inside circle, inside a "!") for a point in 64×64 icon space."""
    circle = (x - 32) ** 2 + (y - 32) ** 2 <= 30 ** 2
    mark = False
    for cx in (24.5, 39.5):
        # The bar: slightly tapered towards the bottom, rounded ends.
        if 14 <= y <= 38:
            half = 4.2 - (y - 14) / 24 * 1.6
            if abs(x - cx) <= half:
                mark = True
        if (x - cx) ** 2 + (y - 14) ** 2 <= 4.2 ** 2:
            mark = True
        if (x - cx) ** 2 + (y - 47) ** 2 <= 4.3 ** 2:   # the dot
            mark = True
    return float(circle), float(mark and circle)


def render(size: int, ss: int = 4) -> bytes:
    """RGBA pixels, supersampled for smooth edges."""
    out = bytearray()
    for py in range(size):
        for px in range(size):
            c = m = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) * 64 / size
                    y = (py + (sy + 0.5) / ss) * 64 / size
                    a, b = coverage(x, y)
                    c += a
                    m += b
            c /= ss * ss
            m /= ss * ss
            t = min(1.0, max(0.0, (px + py) / (2 * size)))
            base = [TOP[i] + (BOTTOM[i] - TOP[i]) * t for i in range(3)]
            # White marks over the gradient, inside the circle.
            col = [base[i] * (1 - m / max(c, 1e-9)) + 255 * (m / max(c, 1e-9)) if c else 0 for i in range(3)]
            out += bytes([round(col[0]), round(col[1]), round(col[2]), round(255 * c)])
    return bytes(out)


def png(size: int, rgba: bytes) -> bytes:
    raw = b"".join(b"\x00" + rgba[y * size * 4:(y + 1) * size * 4] for y in range(size))
    chunk = lambda tag, data: struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)  # noqa: E731
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def main() -> None:
    sizes = [16, 24, 32, 48, 64, 128, 256]
    images = [png(s, render(s, 4 if s <= 64 else 2)) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    for s, data in zip(sizes, images):
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    (ROOT / "app.ico").write_bytes(header + entries + b"".join(images))
    print("wrote", ROOT / "app.ico")


if __name__ == "__main__":
    main()
