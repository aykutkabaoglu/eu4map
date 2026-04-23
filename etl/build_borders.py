"""Generate a binary province-border mask from data/provinces_id.png.

A pixel is "on border" if any of its 4 neighbors belongs to a different province
id. Output is a grayscale PNG at the same resolution as the ID map (5632×2048):
borders are 255, interior is 0.

Run (inside dev container):
    python etl/build_borders.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image


OUT = Path("/workspace/data")
SRC = OUT / "provinces_id.png"
DST = OUT / "province_borders.png"


def main() -> None:
    if not SRC.exists():
        print(f"missing {SRC} — run etl/build.py first", file=sys.stderr)
        sys.exit(1)

    img = np.array(Image.open(SRC))
    # RG8 -> id = R*256 + G
    ids = img[:, :, 0].astype(np.int32) * 256 + img[:, :, 1].astype(np.int32)

    # Mark pixels whose any 4-neighbor has a different id. Shift and compare.
    diff = np.zeros_like(ids, dtype=bool)
    diff[:, 1:] |= ids[:, 1:] != ids[:, :-1]
    diff[:, :-1] |= ids[:, :-1] != ids[:, 1:]
    diff[1:, :] |= ids[1:, :] != ids[:-1, :]
    diff[:-1, :] |= ids[:-1, :] != ids[1:, :]

    mask = (diff.astype(np.uint8) * 255)
    Image.fromarray(mask, mode="L").save(DST, optimize=True)
    pct = 100.0 * mask.astype(bool).mean()
    print(f"wrote {DST} — {pct:.2f}% pixels on border")


if __name__ == "__main__":
    main()
