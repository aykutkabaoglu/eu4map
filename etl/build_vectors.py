#!/usr/bin/env python3
"""
Extracts per-province vector polygons from provinces_id.png using OpenCV contour tracing.

Output: data/province_vectors.bin
Binary format (all little-endian, 4-byte aligned throughout):
  Header  (16 bytes): magic 'PV01' | width u32 | height u32 | num_entries u32
  Per entry:          province_id u16 | num_rings u16
  Per ring:           num_pts u16 | padding u16 | x0 f32 | y0 f32 | ...
"""
import struct
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / "data"
OUT_PATH = DATA_DIR / "province_vectors.bin"

# Douglas-Peucker tolerance in pixels. Higher = fewer vertices, rougher edges.
EPSILON = 0.8


def main() -> None:
    t0 = time.time()
    print("Loading provinces_id.png…")
    img = np.array(Image.open(DATA_DIR / "provinces_id.png"))
    H, W = img.shape[:2]
    print(f"  {W}×{H}")

    province_ids = img[:, :, 0].astype(np.uint32) * 256 + img[:, :, 1].astype(np.uint32)

    # Sort all pixels by province ID once for O(N) subsequent access.
    flat = province_ids.ravel()
    sort_idx = np.argsort(flat, kind="stable")
    sorted_flat = flat[sort_idx]
    uniq, first_pos, counts = np.unique(sorted_flat, return_index=True, return_counts=True)

    id_to_range: dict[int, tuple[int, int]] = {}
    for i, uid in enumerate(uniq):
        if uid > 0:
            id_to_range[int(uid)] = (int(first_pos[i]), int(counts[i]))

    print(f"  {len(id_to_range)} provinces")

    entries: list[tuple[int, list[np.ndarray]]] = []

    for pid_u32, (fp, cnt) in id_to_range.items():
        pid = pid_u32
        pixel_indices = sort_idx[fp : fp + cnt]
        ys = pixel_indices // W
        xs = pixel_indices % W

        y0, y1 = int(ys.min()), int(ys.max())
        x0, x1 = int(xs.min()), int(xs.max())

        # 1-pixel padding so contours on image edges are traced correctly.
        pad = 1
        sub_h = y1 - y0 + 2 * pad + 1
        sub_w = x1 - x0 + 2 * pad + 1
        mask = np.zeros((sub_h, sub_w), dtype=np.uint8)
        mask[ys - y0 + pad, xs - x0 + pad] = 255

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        rings: list[np.ndarray] = []
        for raw in contours:
            approx = cv2.approxPolyDP(raw, EPSILON, True)
            pts = approx.reshape(-1, 2)
            if len(pts) < 3:
                continue
            # Offset back to full-image coords, normalize to [0, 1].
            norm = np.empty(len(pts) * 2, dtype=np.float32)
            norm[0::2] = (pts[:, 0] + x0 - pad).astype(np.float32) / W
            norm[1::2] = (pts[:, 1] + y0 - pad).astype(np.float32) / H
            rings.append(norm)

        if rings:
            entries.append((pid, rings))

    print(f"  Writing {len(entries)} entries…")

    with open(OUT_PATH, "wb") as f:
        f.write(b"PV01")
        f.write(struct.pack("<III", W, H, len(entries)))
        for pid, rings in entries:
            f.write(struct.pack("<HH", pid, len(rings)))
            for ring in rings:
                n_pts = len(ring) // 2
                f.write(struct.pack("<HH", n_pts, 0))  # padding keeps 4-byte alignment
                f.write(ring.tobytes())

    size_mb = OUT_PATH.stat().st_size / 1024 / 1024
    t1 = time.time()
    print(f"  {OUT_PATH.name}: {size_mb:.1f} MB in {t1 - t0:.1f}s")


if __name__ == "__main__":
    main()
