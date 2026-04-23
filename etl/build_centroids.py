"""Compute per-province centroid + pixel count from data/provinces_id.png.

Output: data/province_centroids.json — { "<id>": [cx, cy, area] } where
    cx, cy are texture coordinates in [0, 1]
    area   is the province's pixel count

Run (inside dev container):
    python etl/build_centroids.py
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import numpy as np
from PIL import Image


OUT = Path("/workspace/data")
PNG = OUT / "provinces_id.png"
DB = OUT / "eu4.db"


def main() -> None:
    if not PNG.exists():
        print(f"missing {PNG} — run etl/build.py first", file=sys.stderr)
        sys.exit(1)

    img = np.array(Image.open(PNG))
    h, w = img.shape[:2]
    # RG8 encoding: id = R*256 + G
    ids = img[:, :, 0].astype(np.int32) * 256 + img[:, :, 1].astype(np.int32)
    flat = ids.ravel()

    # Build arrays of x, y, id. Vectorized bincount for O(pixels) total.
    ys, xs = np.indices((h, w))
    xs_f = xs.ravel()
    ys_f = ys.ravel()

    max_id = int(flat.max())
    area = np.bincount(flat, minlength=max_id + 1)
    sum_x = np.bincount(flat, weights=xs_f, minlength=max_id + 1)
    sum_y = np.bincount(flat, weights=ys_f, minlength=max_id + 1)

    # Per-province bounding box via per-id min/max reductions.
    # np.minimum.reduceat-style ops aren't direct; use np.maximum.at / np.minimum.at.
    min_x = np.full(max_id + 1, w, dtype=np.int32)
    max_x = np.full(max_id + 1, -1, dtype=np.int32)
    min_y = np.full(max_id + 1, h, dtype=np.int32)
    max_y = np.full(max_id + 1, -1, dtype=np.int32)
    np.minimum.at(min_x, flat, xs_f)
    np.maximum.at(max_x, flat, xs_f)
    np.minimum.at(min_y, flat, ys_f)
    np.maximum.at(max_y, flat, ys_f)

    out: dict[str, list] = {}
    for pid in range(1, max_id + 1):
        a = int(area[pid])
        if a == 0:
            continue
        cx = float(sum_x[pid] / a) / w
        cy = float(sum_y[pid] / a) / h
        bx0 = float(min_x[pid]) / w
        by0 = float(min_y[pid]) / h
        bx1 = float(max_x[pid] + 1) / w
        by1 = float(max_y[pid] + 1) / h
        out[str(pid)] = [
            round(cx, 5), round(cy, 5), a,
            round(bx0, 5), round(by0, 5), round(bx1, 5), round(by1, 5),
        ]

    dest = OUT / "province_centroids.json"
    dest.write_text(json.dumps(out, separators=(",", ":")))
    print(f"wrote {dest} — {len(out)} provinces")

    # Emit compact id -> name map for UI labels / tooltips.
    names: dict[str, str] = {}
    if DB.exists():
        con = sqlite3.connect(DB)
        try:
            for pid, name in con.execute("SELECT id, name FROM provinces WHERE name IS NOT NULL"):
                names[str(pid)] = name
        finally:
            con.close()
        names_dest = OUT / "province_names.json"
        names_dest.write_text(json.dumps(names, separators=(",", ":"), ensure_ascii=False))
        print(f"wrote {names_dest} — {len(names)} names")


if __name__ == "__main__":
    main()
