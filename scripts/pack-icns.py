#!/usr/bin/env python3
"""Pack a .iconset directory into a .icns file (stdlib only, no iconutil).

`iconutil -c icns` rejects every iconset on macOS 26+ ("Invalid Iconset",
even for sets it used to build), while `iconutil -c iconset` still reads.
This packs the PNG elements directly: the container is just a magic, a total
length, and (OSType, length, PNG-bytes) records, which is all modern macOS
reads. Element set mirrors what shipped before (ic11-ic14 + ic07-ic10),
plus icp6 so the 64px variant has a slot instead of being scaled.

Usage: pack-icns.py <app-icon.iconset> <app-icon.icns>
"""

import struct
import sys
from pathlib import Path

# (iconset filename, OSType, expected pixel size)
ELEMENTS = [
    ("icon_16x16.png", "ic11", 16),
    ("icon_16x16@2x.png", "ic12", 32),
    ("icon_32x32@2x.png", "icp6", 64),
    ("icon_128x128.png", "ic07", 128),
    ("icon_128x128@2x.png", "ic13", 256),
    ("icon_256x256.png", "ic08", 256),
    ("icon_256x256@2x.png", "ic14", 512),
    ("icon_512x512.png", "ic09", 512),
    ("icon_512x512@2x.png", "ic10", 1024),
]

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def png_size(data: bytes) -> tuple[int, int]:
    if data[:8] != PNG_MAGIC:
        raise ValueError("not a PNG")
    w, h = struct.unpack(">II", data[16:24])
    return w, h


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    records = bytearray()
    for name, ostype, size in ELEMENTS:
        data = (src / name).read_bytes()
        w, h = png_size(data)
        if (w, h) != (size, size):
            print(f"{name}: expected {size}x{size}, got {w}x{h}", file=sys.stderr)
            return 1
        records += ostype.encode("ascii") + struct.pack(">I", len(data) + 8) + data
    (dst).write_bytes(b"icns" + struct.pack(">I", len(records) + 8) + bytes(records))
    print(f"wrote {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
