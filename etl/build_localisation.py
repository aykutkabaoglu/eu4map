"""Resolve event title/desc localisation keys into human text (English).

Reads /eu4_raw/localisation/*_l_english.yml (not real YAML — EU4 uses its own
tab-indented `KEY:VERSION "text"` format), then UPDATEs eu4_events.title/desc
with the resolved strings and adds option metadata in a sibling table.

Run (inside dev container) after build_events.py:
    python etl/build_localisation.py
"""

from __future__ import annotations

import re
import sqlite3
import sys
from pathlib import Path


RAW_LOC = Path("/eu4_raw/localisation")
DB = Path("/workspace/data/eu4.db")
ENCODING = "utf-8-sig"  # Paradox localisation files are BOM-UTF-8

# Line format: `  KEY:VERSION "text with §R escapes$VAR|Y$ etc."`
LINE = re.compile(r'^\s*([A-Za-z0-9_.\-]+)\s*:\s*\d+\s*"(.*)"\s*$')

# Strip Paradox in-text color codes (§R...§!), variable placeholders ($VAR|Y$),
# and icon tags (£money£).
STRIP = re.compile(r"§[A-Za-z!]|£[^£\n]*£|\\n")


def load_all() -> dict[str, str]:
    out: dict[str, str] = {}
    files = sorted(RAW_LOC.glob("*_l_english.yml"))
    for path in files:
        try:
            for raw_line in path.read_text(encoding=ENCODING, errors="replace").splitlines():
                m = LINE.match(raw_line)
                if not m:
                    continue
                key, txt = m.group(1), m.group(2)
                txt = STRIP.sub("", txt).strip()
                if txt:
                    out[key] = txt
        except Exception as e:
            print(f"skip {path.name}: {e}", file=sys.stderr)
    return out


def main() -> None:
    if not DB.exists():
        print(f"missing {DB}", file=sys.stderr)
        sys.exit(1)
    if not RAW_LOC.exists():
        print(f"missing {RAW_LOC}", file=sys.stderr)
        sys.exit(1)

    loc = load_all()
    print(f"loaded {len(loc)} localisation keys")

    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    try:
        # Add columns for resolved text (idempotent).
        existing = {r["name"] for r in con.execute("PRAGMA table_info(eu4_events)")}
        if "title_text" not in existing:
            con.execute("ALTER TABLE eu4_events ADD COLUMN title_text TEXT")
        if "desc_text" not in existing:
            con.execute("ALTER TABLE eu4_events ADD COLUMN desc_text TEXT")

        rows = con.execute("SELECT id, title, desc FROM eu4_events").fetchall()
        updates = []
        resolved_title = 0
        resolved_desc = 0
        for r in rows:
            tt = loc.get(r["title"]) if r["title"] else None
            dt = loc.get(r["desc"]) if r["desc"] else None
            if tt:
                resolved_title += 1
            if dt:
                resolved_desc += 1
            updates.append((tt, dt, r["id"]))
        con.executemany(
            "UPDATE eu4_events SET title_text = ?, desc_text = ? WHERE id = ?",
            updates,
        )
        con.commit()
        print(f"resolved {resolved_title}/{len(rows)} titles, {resolved_desc}/{len(rows)} descriptions")
    finally:
        con.close()


if __name__ == "__main__":
    main()
